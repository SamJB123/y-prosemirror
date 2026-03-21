import { Plugin, TextSelection } from 'prosemirror-state'
import { UndoManager, Item, ContentType, Type } from '@y/y'
import { yUndoPluginKey, ySyncPluginKey } from './keys.js'
import { absolutePositionToRelativePosition, relativePositionToAbsolutePosition } from '../sync/positions.js'

/**
 * @typedef {Object} UndoPluginState
 * @property {UndoManager} undoManager
 * @property {{ anchor: import('@y/y').RelativePosition, head: import('@y/y').RelativePosition } | null} prevSel
 * @property {boolean} hasUndoOps
 * @property {boolean} hasRedoOps
 */

/**
 * @param {import('@y/y').Type} ytype
 * @param {import('prosemirror-state').EditorState} state
 * @param {import('@y/y').AbstractAttributionManager} [am]
 * @returns {{ anchor: import('@y/y').RelativePosition, head: import('@y/y').RelativePosition } | null}
 */
function getRelativeSelection (ytype, state, am) {
  try {
    const { $anchor, $head } = state.selection
    return {
      anchor: absolutePositionToRelativePosition($anchor, ytype, am),
      head: absolutePositionToRelativePosition($head, ytype, am)
    }
  } catch {
    return null
  }
}

/**
 * @param {import('prosemirror-state').EditorState} state
 * @return {boolean}
 */
export const undo = state => yUndoPluginKey.getState(state)?.undoManager?.undo() != null

/**
 * @param {import('prosemirror-state').EditorState} state
 * @return {boolean}
 */
export const redo = state => yUndoPluginKey.getState(state)?.undoManager?.redo() != null

/** @type {import('prosemirror-state').Command} */
export const undoCommand = (state, dispatch) =>
  dispatch == null
    ? yUndoPluginKey.getState(state)?.undoManager?.canUndo()
    : undo(state)

/** @type {import('prosemirror-state').Command} */
export const redoCommand = (state, dispatch) =>
  dispatch == null
    ? yUndoPluginKey.getState(state)?.undoManager?.canRedo()
    : redo(state)

export const defaultProtectedNodes = new Set(['paragraph'])

/**
 * @param {import('prosemirror-model').Node} doc
 * @param {number} pos
 * @returns {boolean}
 */
const isInlineSelectionPosition = (doc, pos) => {
  if (typeof pos !== 'number' || pos < 0 || pos > doc.content.size) {
    return false
  }
  try {
    return doc.resolve(pos).parent.inlineContent
  } catch {
    return false
  }
}

/**
 * @param {Item} item
 * @param {Set<string>} protectedNodes
 * @returns {boolean}
 */
export const defaultDeleteFilter = (item, protectedNodes) =>
  !(item instanceof Item) ||
  !(item.content instanceof ContentType) ||
  !(item.content.type instanceof Type && (
    item.content.type.name == null ||
    (item.content.type.name != null && protectedNodes.has(item.content.type.name))
  )) ||
  item.content.type.length === 0

/**
 * @param {object} [options]
 * @param {Set<string>} [options.protectedNodes]
 * @param {any[]} [options.trackedOrigins]
 * @param {UndoManager | null} [options.undoManager]
 */
export const yUndoPlugin = ({
  protectedNodes = defaultProtectedNodes,
  trackedOrigins = [],
  undoManager = null
} = {}) => {
  /**
   * Selection to restore after the next remote-update transaction
   * (set by stack-item-popped, consumed by appendTransaction).
   * @type {{ anchor: import('@y/y').RelativePosition, head: import('@y/y').RelativePosition } | null}
   */
  let pendingSelection = null

  return new Plugin({
    key: yUndoPluginKey,
    state: {
      init: (_, state) => {
        const syncState = ySyncPluginKey.getState(state)
        const ytype = syncState?.ytype
        const _undoManager = undoManager || (ytype
          ? new UndoManager(ytype, {
            trackedOrigins: new Set([ySyncPluginKey].concat(trackedOrigins)),
            deleteFilter: (item) => defaultDeleteFilter(item, protectedNodes),
            captureTransaction: tr => tr.meta.get('addToHistory') !== false
          })
          : null)
        return {
          undoManager: _undoManager,
          prevSel: null,
          hasUndoOps: _undoManager ? _undoManager.undoStack.length > 0 : false,
          hasRedoOps: _undoManager ? _undoManager.redoStack.length > 0 : false
        }
      },
      apply: (tr, val, oldState) => {
        const undoManager = val.undoManager
        if (!undoManager) return val

        const syncState = ySyncPluginKey.getState(oldState)
        const ytype = syncState?.ytype
        const am = syncState?.attributionManager

        const hasUndoOps = undoManager.undoStack.length > 0
        const hasRedoOps = undoManager.redoStack.length > 0

        if (ytype) {
          return {
            undoManager,
            prevSel: getRelativeSelection(ytype, oldState, am),
            hasUndoOps,
            hasRedoOps
          }
        }

        if (hasUndoOps !== val.hasUndoOps || hasRedoOps !== val.hasRedoOps) {
          return { ...val, hasUndoOps, hasRedoOps }
        }

        return val
      }
    },
    view: (view) => {
      const undoState = yUndoPluginKey.getState(view.state)
      const _undoManager = undoState?.undoManager
      if (!_undoManager) return { destroy () {} }

      // If the UndoManager was previously destroyed (e.g., by React strict mode
      // unmounting and remounting the view), re-register its handler.
      if (!_undoManager.trackedOrigins.has(_undoManager)) {
        _undoManager.trackedOrigins.add(_undoManager)
        _undoManager.doc.on('afterTransaction', _undoManager.afterTransactionHandler)
      }

      /** @param {{ stackItem: InstanceType<typeof import('@y/y').StackItem> }} event */
      const onStackItemAdded = ({ stackItem }) => {
        const prevSel = yUndoPluginKey.getState(view.state)?.prevSel
        if (prevSel) {
          stackItem.meta.set('relative-selection', prevSel)
        }
      }

      /** @param {{ stackItem: InstanceType<typeof import('@y/y').StackItem> }} event */
      const onStackItemPopped = ({ stackItem }) => {
        const sel = stackItem.meta.get('relative-selection')
        if (sel) {
          pendingSelection = sel
        }
      }

      _undoManager.on('stack-item-added', onStackItemAdded)
      _undoManager.on('stack-item-popped', onStackItemPopped)

      return {
        destroy () {
          _undoManager.off('stack-item-added', onStackItemAdded)
          _undoManager.off('stack-item-popped', onStackItemPopped)
          // Don't destroy the UndoManager — it's owned by the plugin state
          // and may be reused if the view is remounted (e.g., React strict mode).
          // It self-destructs via doc.on('destroy') registered in its constructor.
        }
      }
    },
    appendTransaction: (transactions, _oldState, newState) => {
      if (!pendingSelection) return null

      const isRemoteUpdate = transactions.some(
        tr => tr.getMeta(ySyncPluginKey)?.type === 'remote-update'
      )
      if (!isRemoteUpdate) return null

      const syncState = ySyncPluginKey.getState(newState)
      const ytype = syncState?.ytype
      const am = syncState?.attributionManager
      if (!ytype) {
        pendingSelection = null
        return null
      }

      const anchor = relativePositionToAbsolutePosition(
        pendingSelection.anchor, ytype, newState.doc, am
      )
      const head = relativePositionToAbsolutePosition(
        pendingSelection.head, ytype, newState.doc, am
      )
      pendingSelection = null

      let sel = null
      if (
        anchor != null &&
        head != null &&
        isInlineSelectionPosition(newState.doc, anchor) &&
        isInlineSelectionPosition(newState.doc, head)
      ) {
        try {
          sel = TextSelection.create(newState.doc, anchor, head)
        } catch {
          // Position resolved to a non-inline node (e.g. blockContainer
          // kept by deleteFilter). Fall through to the fallback below.
        }
      }
      // Guarantee a valid cursor position — TextSelection.atStart always
      // finds the first text-containing node in the document.
      if (!sel) {
        sel = TextSelection.atStart(newState.doc)
      }
      const tr = newState.tr.setSelection(sel)
      tr.setMeta('addToHistory', false)
      return tr
    }
  })
}
