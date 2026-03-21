import * as Y from '@y/y'
import * as delta from 'lib0/delta'
import * as error from 'lib0/error'
import * as mux from 'lib0/mutex'
import { Plugin } from 'prosemirror-state'
import {
  defaultMapAttributionToMark,
  deltaAttributionToFormat,
  deltaToPSteps,
  fragmentToTr,
  pmToFragment,
  nodeToDelta,
  syncStructuralChangesToYFragment
} from '../../sync/index.js'
import { ySyncPluginKey } from '../keys.js'

/**
 * @typedef {import('./types.js').SyncPluginState} SyncPluginState
 * @typedef {import('./types.js').SyncPluginTransactionMeta} SyncPluginTransactionMeta
 */

// This is a pure function of the transaction and the previous plugin state
/** @type {import('prosemirror-state').StateField<SyncPluginState>['apply']} */
const transactionOriginatesFromRemoteUpdate = tr => {
  let current = tr
  while (current) {
    const syncMeta = current.getMeta(ySyncPluginKey)
    if (syncMeta?.type === 'remote-update') {
      return true
    }
    current = current.getMeta('appendedTransaction')
  }
  return false
}

function apply (tr, prevPluginState) {
  /** @type {SyncPluginTransactionMeta | undefined} */
  const trMeta = tr.getMeta(ySyncPluginKey)

  // Capture document-changing transactions (only in synced mode, and not sync plugin meta transactions)
  if (
    tr.docChanged &&
    !trMeta &&
    prevPluginState.type === 'synced' &&
    !transactionOriginatesFromRemoteUpdate(tr)
  ) {
    return {
      ...prevPluginState,
      capturedTransactions: prevPluginState.capturedTransactions.concat(tr)
    }
  }

  // Handle sync plugin meta transactions
  if (trMeta) {
    switch (trMeta.type) {
      case 'pause-mode': {
        if (prevPluginState.type === 'paused') {
          // already paused, no-op
          return prevPluginState
        }
        return {
          type: 'paused',
          previousState: prevPluginState,
          capturedTransactions: []
        }
      }
      case 'sync-mode': {
        // When switching to sync mode from paused, get ytype and attributionManager from previousState or meta
        // Also allow switching ytype/attributionManager when already synced
        const nextYtype = trMeta.ytype ?? (prevPluginState.type === 'paused' ? prevPluginState.previousState?.ytype : prevPluginState.ytype)
        const nextAttributionManager = trMeta.attributionManager ?? (prevPluginState.type === 'paused' ? prevPluginState.previousState?.attributionManager : prevPluginState.attributionManager)

        if (!nextYtype) {
          throw new Error('[y/prosemirror]: sync-mode meta.ytype is required')
        }

        // If already synced and nothing changed, no-op
        if (prevPluginState.type === 'synced' &&
            prevPluginState.ytype === nextYtype &&
            prevPluginState.attributionManager === nextAttributionManager) {
          return prevPluginState
        }

        return {
          type: 'synced',
          ytype: nextYtype,
          attributionManager: nextAttributionManager || null,
          capturedTransactions: []
        }
      }
      case 'remote-update': {
        // no-op for state, this is for other plugins
        return prevPluginState
      }
      case 'initialized': {
        // no-op for state
        return prevPluginState
      }
      default: {
        error.unexpectedCase()
      }
    }
  }

  // No meta and not a document-changing transaction, return unchanged
  return prevPluginState
}

/**
 * @typedef {{ rootTypeKey: string, rootTypeName: string | null | undefined, path: Array<string|number> }} TypeLocator
 */

/**
 * @param {Y.Type} ytype
 * @returns {TypeLocator}
 */
const getTypeLocator = ytype => {
  let rootType = ytype
  while (rootType._item !== null) {
    rootType = /** @type {Y.Type} */ (rootType._item.parent)
  }
  const rootTypeKey = Y.findRootTypeKey(rootType)
  return {
    rootTypeKey,
    rootTypeName: rootType.name,
    path: rootType === ytype ? [] : Y.getPathTo(rootType, ytype)
  }
}

/**
 * @param {Y.Doc} doc
 * @param {TypeLocator} typeLocator
 * @returns {Y.Type}
 */
const resolveTypeInDoc = (doc, typeLocator) => {
  /** @type {any} */
  let type = doc.get(typeLocator.rootTypeKey, typeLocator.rootTypeName ?? null)
  typeLocator.path.forEach(segment => {
    type = typeof segment === 'number' ? type.get(segment) : type.getAttr(segment)
  })
  return type
}

/**
 * @param {Y.Type} ytype
 * @param {TypeLocator} typeLocator
 * @returns {Y.Doc}
 */
const cloneShadowDocFromYType = (ytype, typeLocator) => {
  const doc = Y.cloneDoc(ytype.doc, {
    isSuggestionDoc: ytype.doc?.isSuggestionDoc ?? false
  })
  resolveTypeInDoc(doc, typeLocator)
  return doc
}

/**
 * @param {import('prosemirror-model').Node} pdoc
 * @param {TypeLocator} typeLocator
 * @returns {Y.Doc}
 */
const createShadowDocFromPmDoc = (pdoc, typeLocator) => {
  const doc = new Y.Doc({
    isSuggestionDoc: false
  })
  const shadowType = doc.get(typeLocator.rootTypeKey, typeLocator.rootTypeName ?? null)
  let currentType = shadowType
  typeLocator.path.forEach(segment => {
    const childType = new Y.Type()
    if (typeof segment === 'number') {
      while (currentType.length < segment) {
        currentType.insert(currentType.length, [new Y.Type()])
      }
      if (currentType.length === segment) {
        currentType.insert(segment, [childType])
      }
      currentType = /** @type {Y.Type} */ (currentType.get(segment))
    } else {
      currentType.setAttr(segment, childType)
      currentType = /** @type {Y.Type} */ (currentType.getAttr(segment))
    }
  })
  pmToFragment(pdoc, currentType, { attributionManager: Y.noAttributionsManager })
  return doc
}

/**
 * @param {any} docDelta
 * @param {TypeLocator} typeLocator
 */
const extractTypeDelta = (docDelta, typeLocator) => {
  const rootOp = docDelta.attrs?.[typeLocator.rootTypeKey]
  if (rootOp == null) {
    return delta.create(typeLocator.rootTypeName ?? null).done()
  }
  if (rootOp.value == null) {
    throw new Error('[y/prosemirror]: root shared type diff is not a modify operation')
  }
  let currentDelta = rootOp.value.done ? rootOp.value.done() : rootOp.value
  typeLocator.path.forEach(segment => {
    if (typeof segment === 'number') {
      let childIndex = 0
      let nextDelta = null
      for (const child of currentDelta.children ?? []) {
        if (child?.type === 'retain') {
          childIndex += child.retain
          continue
        }
        if (child?.type === 'modify') {
          if (childIndex === segment) {
            nextDelta = child.value.done ? child.value.done() : child.value
            break
          }
          childIndex += 1
          continue
        }
        if (child?.type === 'delete') {
          childIndex += child.delete
          continue
        }
        if (child?.type === 'insert') {
          childIndex += Array.isArray(child.insert) ? child.insert.length : 1
        }
      }
      currentDelta = nextDelta ?? delta.create().done()
      return
    }
    const attrOp = currentDelta.attrs?.[segment]
    currentDelta = attrOp?.value?.done ? attrOp.value.done() : (attrOp?.value ?? delta.create().done())
  })
  return currentDelta
}

/**
 * @param {any} d
 */
const deltaHasChanges = d => {
  const json = d?.toJSON && typeof d.toJSON === 'function' ? d.toJSON() : d
  const hasChangesInJson = node => {
    if (node == null || typeof node !== 'object') {
      return false
    }
    if (node.attrs && Object.keys(node.attrs).length > 0) {
      return true
    }
    if (!Array.isArray(node.children)) {
      return false
    }
    return node.children.some(child => {
      if (child == null || typeof child !== 'object') {
        return false
      }
      if (child.type === 'insert' || child.type === 'text') {
        return true
      }
      if (child.delete != null || child.type === 'delete') {
        return true
      }
      if (child.type === 'retain') {
        return child.format != null && Object.keys(child.format).length > 0
      }
      if (child.type === 'modify') {
        if (child.format != null && Object.keys(child.format).length > 0) {
          return true
        }
        return hasChangesInJson(child.value)
      }
      return true
    })
  }
  return hasChangesInJson(json)
}

const shouldHydrateViaFullFragmentDiff = d => {
  let hasDelete = false
  let hasInsert = false
  let hasFormattingRetain = false

  const visit = node => {
    if (node == null || typeof node !== 'object') return
    const attrs = node.attrs ?? {}
    if (Object.keys(attrs).length > 0) {
      return
    }
    const children = Array.isArray(node.children) ? node.children : []
    children.forEach(child => {
      if (child == null || typeof child !== 'object') return
      if (child.type === 'insert' || child.type === 'text' || child.insert != null) {
        hasInsert = true
        return
      }
      if (child.type === 'delete' || child.delete != null) {
        hasDelete = true
        return
      }
      if (child.type === 'retain' && child.format != null && Object.keys(child.format).length > 0) {
        hasFormattingRetain = true
        return
      }
      if (child.type === 'modify') {
        visit(child.value)
      }
    })
  }

  visit(d.toJSON?.() ?? d)
  return hasDelete
}

/**
 * Group captured transactions by consecutive addToHistory intent.
 *
 * @param {Array<import('prosemirror-state').Transaction>} captured
 */
const groupCapturedTransactions = captured => {
  /**
   * @type {Array<{ captured: Array<import('prosemirror-state').Transaction>, addToHistory: boolean }>}
   */
  const groups = []
  /** @type {Array<import('prosemirror-state').Transaction>} */
  let currentGroup = []
  let currentAddToHistory = true

  captured.forEach((pmTr, index) => {
    const addToHistory = pmTr.getMeta('addToHistory') !== false
    if (index === 0) {
      currentGroup = [pmTr]
      currentAddToHistory = addToHistory
      return
    }

    if (addToHistory === currentAddToHistory) {
      currentGroup.push(pmTr)
      return
    }

    groups.push({
      captured: currentGroup,
      addToHistory: currentAddToHistory
    })
    currentGroup = [pmTr]
    currentAddToHistory = addToHistory
  })

  if (currentGroup.length > 0) {
    groups.push({
      captured: currentGroup,
      addToHistory: currentAddToHistory
    })
  }

  return groups
}

/**
 * This Prosemirror {@link Plugin} is responsible for synchronizing the prosemirror {@link EditorState} with a {@link Y.XmlFragment}
 * @param {Y.Type} ytype
 * @param {object} opts
 * @param {Y.AbstractAttributionManager} [opts.attributionManager] An {@link Y.AbstractAttributionManager} to use for attribution tracking
 * @param {Y.Doc} [opts.suggestionDoc] A {@link Y.Doc} to use for suggestion tracking
 * @param {typeof defaultMapAttributionToMark} [opts.mapAttributionToMark] A function to map the {@link Y.Attribution} to a {@link import('prosemirror-model').Mark}
 * @param {()=>void} [opts.onFirstRender] This callback is called on first render
 * @returns {Plugin}
 */
export function syncPlugin (ytype, {
  attributionManager = Y.noAttributionsManager,
  mapAttributionToMark = defaultMapAttributionToMark,
  onFirstRender = () => {}
} = {}) {
  const mutex = mux.createMutex()
  const typeLocator = getTypeLocator(ytype)
  // Store the current subscription unsubscribe function
  /** @type {(() => void) | null} */
  let unsubscribeFn = null
  /** @type {Y.Doc | null} */
  let shadowDoc = null

  /**
   * Subscribe to ytype changes and apply remote updates to prosemirror
   * @param {object} opts
   * @param {import('prosemirror-view').EditorView} opts.view
   * @param {Y.Type} opts.ytype
   * @param {Y.AbstractAttributionManager} opts.attributionManager
   * @param {typeof defaultMapAttributionToMark} opts.mapAttributionToMark
   */
  function subscribeToYType ({ view, ytype, attributionManager, mapAttributionToMark }) {
    // Unsubscribe from previous subscription if it exists
    if (unsubscribeFn) {
      unsubscribeFn()
      unsubscribeFn = null
    }

    // Track if ytype has been initialized
    let isYTypeInitialized = !!ytype.length

    const yTypeCb = ytype.observeDeep((change, tr) => {
      if (!view || view.isDestroyed) {
        // View is destroyed, clean up
        if (unsubscribeFn) {
          unsubscribeFn()
          unsubscribeFn = null
        }
        return
      }

      // Get latest plugin state
      const pluginState = ySyncPluginKey.getState(view.state)
      if (!pluginState) {
        return
      }

      // Only process if in synced mode
      if (pluginState.type !== 'synced') {
        return
      }

      mutex(() => {
        const nextShadowDoc = cloneShadowDocFromYType(ytype, typeLocator)
        if (!isYTypeInitialized) {
          // First remote update before init completed: diff the full Y.Type
          // content against the current PM doc, not the incremental event delta
          // (event deltas contain ModifyOps which are structurally incompatible
          // with the full-doc InsertOps that nodeToDelta produces).
          const ytypeContent = deltaAttributionToFormat(
            ytype.toDelta(attributionManager, { deep: true }),
            mapAttributionToMark
          ).done()
          const d = delta.diff(nodeToDelta(view.state.doc).done(), ytypeContent)
          const ptr = deltaToPSteps(view.state.tr, d)

          ptr.setMeta(ySyncPluginKey, {
            type: 'remote-update',
            change,
            ytype
          })
          ptr.setMeta('addToHistory', false)
          if (ptr.steps.length > 0) {
            view.dispatch(ptr)
          }
        } else {
          shadowDoc = shadowDoc ?? createShadowDocFromPmDoc(view.state.doc, typeLocator)
          const docDelta = Y.diffDocsToDelta(shadowDoc, nextShadowDoc, {
            am: attributionManager
          }).done()
          const rootDelta = extractTypeDelta(docDelta, typeLocator)
          const d = deltaAttributionToFormat(rootDelta, mapAttributionToMark).done()
          if (deltaHasChanges(d)) {
            let ptr
            if (shouldHydrateViaFullFragmentDiff(d)) {
              ptr = fragmentToTr(ytype, view.state.tr, {
                attributionManager,
                mapAttributionToMark
              })
            } else {
              ptr = deltaToPSteps(view.state.tr, d)
            }
            ptr.setMeta(ySyncPluginKey, {
              type: 'remote-update',
              change,
              ytype
            })
            ptr.setMeta('addToHistory', false)
            if (ptr.steps.length > 0) {
              view.dispatch(ptr)
            }
          }
        }

        shadowDoc = nextShadowDoc
        isYTypeInitialized = true
      })
    })

    unsubscribeFn = () => {
      ytype.unobserveDeep(yTypeCb)
      unsubscribeFn = null
    }
  }

  /**
   * Unsubscribe from ytype changes
   */
  function unsubscribeFromYType () {
    if (unsubscribeFn) {
      unsubscribeFn()
      unsubscribeFn = null
    }
  }

  return /** @type {Plugin<import('./types.js').SyncPluginState>} */ (new Plugin({
    key: ySyncPluginKey,
    state: {
      init: () => {
        return {
          type: 'synced',
          ytype,
          attributionManager,
          capturedTransactions: []
        }
      },
      apply
    },
    view (view) {
      const pluginState = ySyncPluginKey.getState(view.state)

      if (!pluginState) {
        throw new Error('[y/prosemirror]: plugin state not found in view.state')
      }

      if (ytype.length === 0) {
        const tr = view.state.tr
        tr.setMeta(ySyncPluginKey, {
          type: 'initialized',
          ytype,
          attributionManager
        })
        tr.setMeta('addToHistory', false)
        view.dispatch(tr)
      }

      // initialize the prosemirror state with what is in the ydoc
      // we wait a tick, because in some cases, the view can be immediately destroyed
      const initializationTimeoutId = setTimeout(() => {
        if (view.isDestroyed) {
          return
        }

        const currentPluginState = ySyncPluginKey.getState(view.state)
        if (!currentPluginState) {
          return
        }

        // ydoc content should always "win" over pm doc content
        if (ytype.length === 0) {
          // ytype is empty, render prosemirror doc to ytype if it has content
          const pmHasContent = view.state.doc.content.findDiffStart(
            view.state.doc.type.createAndFill().content
          ) !== null

          if (pmHasContent) {
            // Apply prosemirror content to ytype.
            // Mark as non-undoable so the UndoManager doesn't capture the
            // initial document structure (undoing it would destroy everything).
            ytype.doc.transact((tr) => {
              tr.meta.set('addToHistory', false)
              pmToFragment(view.state.doc, ytype, { attributionManager })
            }, ySyncPluginKey)
          }
        } else {
          // ytype has content, render it to prosemirror
          const tr = fragmentToTr(ytype, view.state.tr, {
            attributionManager,
            mapAttributionToMark
          })

          /** @type {SyncPluginTransactionMeta} */
          const pluginMeta = {
            type: 'initialized',
            ytype,
            attributionManager
          }
          tr.setMeta(ySyncPluginKey, pluginMeta)
          tr.setMeta('addToHistory', false)
          view.dispatch(tr)
        }

        shadowDoc = cloneShadowDocFromYType(ytype, typeLocator)

        // Call onFirstRender callback
        onFirstRender()

        // subscribe to the ydoc changes, after initialization is complete
        subscribeToYType({
          view,
          ytype,
          attributionManager,
          mapAttributionToMark
        })
      }, 0)

      return {
        update (view, prevState) {
          const pluginState = ySyncPluginKey.getState(view.state)
          const prevPluginState = ySyncPluginKey.getState(prevState)

          if (!pluginState) {
            error.unexpectedCase()
            return
          }

          if (pluginState.type === 'synced') {
            // Handle mode transition from paused to synced, or switching ytype/attributionManager
            const prevYtype = prevPluginState?.type === 'synced' ? prevPluginState.ytype : (prevPluginState?.type === 'paused' ? prevPluginState.previousState?.ytype : undefined)
            const prevAttributionManager = prevPluginState?.type === 'synced' ? prevPluginState.attributionManager : (prevPluginState?.type === 'paused' ? prevPluginState.previousState?.attributionManager : undefined)

            const ytypeChanged = prevYtype !== pluginState.ytype
            const attributionManagerChanged = prevAttributionManager !== pluginState.attributionManager
            const wasPaused = prevPluginState?.type === 'paused'

            if (wasPaused || ytypeChanged || attributionManagerChanged) {
              // Subscribe to the new ytype/attributionManager
              // (subscribeToYType will automatically unsubscribe from previous if needed)
              subscribeToYType({
                view,
                ytype: pluginState.ytype,
                attributionManager: pluginState.attributionManager,
                mapAttributionToMark
              })
              shadowDoc = cloneShadowDocFromYType(pluginState.ytype, typeLocator)
            }

            // Process captured transactions and apply to ytype
            if (pluginState.capturedTransactions.length > 0) {
              mutex(() => {
                const capturedGroups = groupCapturedTransactions(pluginState.capturedTransactions)

                // Seed the previous ProseMirror state separately and without
                // history. If we combine this bootstrap with the user's first
                // edit, undo can end up owning the structural parent items and
                // remove later remote edits nested under them.
                if (pluginState.ytype.length === 0) {
                  pluginState.ytype.doc.transact((tr) => {
                    tr.meta.set('addToHistory', false)
                    pmToFragment(prevState.doc, pluginState.ytype, {
                      attributionManager: pluginState.attributionManager
                    })
                  }, ySyncPluginKey)
                  shadowDoc = createShadowDocFromPmDoc(prevState.doc, typeLocator)
                }

                for (let groupIndex = 0; groupIndex < capturedGroups.length; groupIndex++) {
                  const { captured, addToHistory } = capturedGroups[groupIndex]
                  const nextGroup = capturedGroups[groupIndex + 1]
                  const shouldMergeNextUniqueIdGroup =
                    addToHistory &&
                    nextGroup?.addToHistory === false &&
                    nextGroup.captured.length > 0 &&
                    nextGroup.captured.every(pmTr => pmTr.getMeta('uniqueID'))

                  // Transactions that originated from remote Y.Doc updates
                  // (observeDeep -> PM dispatch) should remain non-local when
                  // written back to the Y.Doc so the UndoManager does not
                  // capture them on suggestion/mirror editors.
                  const isLocal = !captured.some(
                    pmTr => pmTr.getMeta(ySyncPluginKey)?.type === 'remote-update'
                  )
                  shadowDoc = shadowDoc ?? createShadowDocFromPmDoc(captured[0].before, typeLocator)
                  const targetDoc = shouldMergeNextUniqueIdGroup
                    ? nextGroup.captured[nextGroup.captured.length - 1].doc
                    : captured[captured.length - 1].doc

                  Y.transact(pluginState.ytype.doc, (tr) => {
                    tr.meta.set('addToHistory', addToHistory)
                    syncStructuralChangesToYFragment(
                      pluginState.ytype,
                      captured[0].before,
                      targetDoc,
                      { attributionManager: pluginState.attributionManager }
                    )
                  }, ySyncPluginKey, isLocal)

                  shadowDoc = cloneShadowDocFromYType(pluginState.ytype, typeLocator)
                  if (shouldMergeNextUniqueIdGroup) {
                    groupIndex++
                  }
                }

                pluginState.capturedTransactions = []
              })
            }
          } else if (pluginState.type === 'paused') {
            // Handle mode transition from synced to paused
            if (prevPluginState?.type === 'synced') {
              // Unsubscribe from the ydoc changes
              unsubscribeFromYType()
            }
            // Skip applying transactions to ytype when paused
          } else {
            error.unexpectedCase()
          }
        },
        destroy () {
          clearTimeout(initializationTimeoutId)
          unsubscribeFromYType()
        }
      }
    }
  }))
}
