import * as Y from '@y/y'
import * as delta from 'lib0/delta'
import * as error from 'lib0/error'
import * as math from 'lib0/math'
import * as object from 'lib0/object'
import * as s from 'lib0/schema'
import { Node } from 'prosemirror-model'
import {
  AddMarkStep,
  AddNodeMarkStep,
  AttrStep,
  DocAttrStep,
  RemoveMarkStep,
  RemoveNodeMarkStep,
  ReplaceAroundStep,
  ReplaceStep
} from 'prosemirror-transform'

export const $prosemirrorDelta = delta.$delta({ name: s.$string, attrs: s.$record(s.$string, s.$any), text: true, recursiveChildren: true })

/**
 * @typedef {s.Unwrap<typeof $prosemirrorDelta>} ProsemirrorDelta
 **/

/**
 * @template {import('lib0/delta').Attribution} T
 * @param {Record<string, unknown> | null} format
 * @param {T} attribution
 * @returns {Record<string, unknown> | null}
 */
export const defaultMapAttributionToMark = (format, attribution) => {
  /**
   * @type {Record<string, unknown> | null}
   */
  let mergeWith = null
  if (attribution.insert) {
    mergeWith = {
      'y-attribution-insertion': {
        userIds: attribution.insert ? attribution.insert : null,
        timestamp: attribution.insertAt ? attribution.insertAt : null
      }
    }
  } else if (attribution.delete) {
    mergeWith = {
      'y-attribution-deletion': {
        userIds: attribution.delete ? attribution.delete : null,
        timestamp: attribution.deleteAt ? attribution.deleteAt : null
      }
    }
  } else if (attribution.format) {
    mergeWith = {
      'y-attribution-format': {
        userIdsByAttr: attribution.format ? attribution.format : null,
        timestamp: attribution.formatAt ? attribution.formatAt : null
      }
    }
  }
  return object.assign({}, format, mergeWith)
}

/**
 * Transform delta with attributions to delta with formats (marks).
 */
export const deltaAttributionToFormat = s.match(s.$function)
  .if(delta.$deltaAny, (d, attributionsToFormat) => {
    const r = delta.create(d.name)
    // @todo this shouldn't be necessary
    for (const attr of d.attrs) {
      r.attrs[attr.key] = attr.clone()
    }
    for (const child of d.children) {
      if (delta.$deleteOp.check(child)) {
        r.delete(child.delete)
      } else {
        const format = child.attribution ? attributionsToFormat(child.format, child.attribution) : child.format
        if (delta.$insertOp.check(child)) {
          r.insert(child.insert.map(c => delta.$deltaAny.check(c) ? deltaAttributionToFormat(c, attributionsToFormat) : c), format)
        } else if (delta.$textOp.check(child)) {
          r.insert(child.insert.slice(), format)
        } else if (delta.$retainOp.check(child)) {
          r.retain(child.retain, format)
        } else if (delta.$modifyOp.check(child)) {
          r.modify(deltaAttributionToFormat(child.value, attributionsToFormat), format)
        } else {
          error.unexpectedCase()
        }
      }
    }
    return /** @type {ProsemirrorDelta} */ (r)
  }).done()

/**
 * @param {readonly import('prosemirror-model').Mark[]} marks
 */
const marksToFormattingAttributes = marks => {
  if (marks.length === 0) return null
  /**
   * @type {{[key:string]:any}}
   */
  const formatting = {}
  marks.forEach(mark => {
    formatting[mark.type.name] = mark.attrs
  })
  return formatting
}

/**
 * @param {{[key:string]:any}|null} formatting
 * @param {import('prosemirror-model').Schema} schema
 */
const formattingAttributesToMarks = (formatting, schema) => object.map(formatting ?? {}, (v, k) => schema.mark(k, v))

/**
 * @param {Array<Node>} ns
 * @return {ProsemirrorDelta}
 */
export const nodesToDelta = ns => {
  /**
   * @type {delta.DeltaBuilderAny}
   */
  const d = delta.create($prosemirrorDelta)
  ns.forEach(n => {
    d.insert(n.isText ? (n.text ?? []) : [nodeToDelta(n)], marksToFormattingAttributes(n.marks))
  })
  return d.done(false)
}

/**
 * Transforms a {@link Node} into a {@link Y.XmlFragment}
 * @param {Node} node
 * @param {Y.Type} fragment
 * @param {Object} [opts]
 * @param {Y.AbstractAttributionManager} [opts.attributionManager]
 * @returns {Y.Type}
 */
export function pmToFragment (node, fragment, { attributionManager = Y.noAttributionsManager } = {}) {
  const initialPDelta = nodeToDelta(node).done()
  fragment.applyDelta(initialPDelta, attributionManager)

  return fragment
}

/**
 * Applies a {@link Y.XmlFragment}'s content as a ProseMirror {@link Transaction}
 * @param {Y.Type} fragment
 * @param {import('prosemirror-state').Transaction} tr
 * @param {object} ctx
 * @param {Y.AbstractAttributionManager} [ctx.attributionManager]
 * @param {typeof defaultMapAttributionToMark} [ctx.mapAttributionToMark]
 * @returns {import('prosemirror-state').Transaction}
 */
export function fragmentToTr (fragment, tr, {
  attributionManager = Y.noAttributionsManager,
  mapAttributionToMark = defaultMapAttributionToMark
} = {}) {
  const fragmentContent = deltaAttributionToFormat(
    fragment.toDelta(attributionManager, { deep: true }),
    mapAttributionToMark
  )
  const initialPDelta = nodeToDelta(tr.doc).done()
  const deltaBetweenPmAndFragment = delta.diff(initialPDelta, fragmentContent).done()

  return deltaToPSteps(tr, deltaBetweenPmAndFragment).setMeta('y-sync-hydration', {
    delta: deltaBetweenPmAndFragment
  })
}

/**
 * Build a ProseMirror doc directly from the current Y.Type content,
 * bypassing deltaToPSteps. Useful for structural remote updates where
 * step generation can produce unstable intermediate replacements.
 *
 * @param {Y.Type} fragment
 * @param {import('prosemirror-model').Schema} schema
 * @param {object} ctx
 * @param {Y.AbstractAttributionManager} [ctx.attributionManager]
 * @param {typeof defaultMapAttributionToMark} [ctx.mapAttributionToMark]
 * @returns {Node}
 */
export function fragmentToDoc (fragment, schema, {
  attributionManager = Y.noAttributionsManager,
  mapAttributionToMark = defaultMapAttributionToMark
} = {}) {
  const fragmentContent = deltaAttributionToFormat(
    fragment.toDelta(attributionManager, { deep: true }),
    mapAttributionToMark
  )
  const children = []
  fragmentContent.children.forEach(op => {
    if (delta.$insertOp.check(op)) {
      children.push(...op.insert.map(ins => deltaToPNode(ins, schema, op.format)))
    }
  })
  return schema.topNodeType.create(null, children)
}

/**
 * Transforms a {@link Y.XmlFragment} into a {@link Node}
 * @param {Y.Type} fragment
 * @param {import('prosemirror-state').Transaction} tr
 * @return {Node}
 */
export function fragmentToPm (fragment, tr) {
  return fragmentToTr(fragment, tr).doc
}

/**
 * @param {Node} n
 */
export const nodeToDelta = n => {
  /**
   * @type {delta.DeltaBuilderAny}
   */
  const d = delta.create(n.type.name, $prosemirrorDelta)
  d.setAttrs(n.attrs)
  n.content.content.forEach(c => {
    d.insert(c.isText ? (c.text ?? []) : [nodeToDelta(c)], marksToFormattingAttributes(c.marks))
  })
  return d
}

const highSurrogateRegex = /[\uD800-\uDBFF]/
const lowSurrogateRegex = /[\uDC00-\uDFFF]/

const simpleDiffString = (a, b) => {
  let left = 0
  let right = 0
  while (left < a.length && left < b.length && a[left] === b[left]) {
    left++
  }
  if (left > 0 && highSurrogateRegex.test(a[left - 1])) left--
  while (right + left < a.length && right + left < b.length && a[a.length - right - 1] === b[b.length - right - 1]) {
    right++
  }
  if (right > 0 && lowSurrogateRegex.test(a[a.length - right])) right--
  return {
    index: left,
    remove: a.length - left - right,
    insert: b.slice(left, b.length - right)
  }
}

const equalAttrs = (left, right) => {
  if (left === right) return true
  if (left == null || right == null) return left == null && right == null
  if (typeof left !== 'object' || typeof right !== 'object') return false
  const leftKeys = Object.keys(left).filter(key => left[key] != null && key !== 'ychange')
  const rightKeys = Object.keys(right).filter(key => right[key] != null && key !== 'ychange')
  if (leftKeys.length !== rightKeys.length) return false
  return leftKeys.every(key => equalAttrs(left[key], right[key]))
}

const normalizePNodeContent = pnode => {
  const res = []
  for (let i = 0; i < pnode.content.content.length; i++) {
    const node = pnode.content.content[i]
    if (node.isText) {
      const textNodes = []
      for (let textNode = pnode.content.content[i]; i < pnode.content.content.length && textNode.isText; textNode = pnode.content.content[++i]) {
        textNodes.push(textNode)
      }
      i--
      res.push(textNodes)
    } else {
      res.push(node)
    }
  }
  return res
}

const marksToAttributes = marks => {
  const attrs = {}
  marks.forEach(mark => {
    if (mark.type.name !== 'ychange') {
      attrs[mark.type.name] = mark.attrs
    }
  })
  return attrs
}

const createTypeFromTextNodes = (ptexts, attributionManager) => {
  const type = new Y.Type()
  const d = delta.create()
  ptexts.forEach(ptext => {
    d.insert(ptext.text ?? '', marksToAttributes(ptext.marks))
  })
  type.applyDelta(d.done(), attributionManager)
  return type
}

const createTypeFromElementNode = (pnode, attributionManager) => {
  const type = new Y.Type(pnode.type.name)
  Object.keys(pnode.attrs).forEach(key => {
    const value = pnode.attrs[key]
    if (value != null && key !== 'ychange') {
      type.setAttr(key, value)
    }
  })
  const children = normalizePNodeContent(pnode).map(child => createTypeFromTextOrElementNode(child, attributionManager))
  if (children.length > 0) {
    type.insert(0, children)
  }
  return type
}

const createTypeFromTextOrElementNode = (pnode, attributionManager) =>
  Array.isArray(pnode)
    ? createTypeFromTextNodes(pnode, attributionManager)
    : createTypeFromElementNode(pnode, attributionManager)

const yTextToStringAndAttrs = ytext => {
  let text = ''
  const attrs = {}
  for (const op of ytext.toDelta()) {
    if (typeof op.insert === 'string') {
      text += op.insert
    }
    Object.keys(op.attributes || op.format || {}).forEach(key => {
      attrs[key] = null
    })
  }
  return { text, attrs }
}

const updateYText = (ytext, ptexts, attributionManager) => {
  const { text, attrs: nullAttrs } = yTextToStringAndAttrs(ytext)
  const content = ptexts.map(ptext => ({
    insert: ptext.text ?? '',
    attrs: Object.assign({}, nullAttrs, marksToAttributes(ptext.marks))
  }))
  const nextText = content.map(c => c.insert).join('')
  const { index, remove, insert } = simpleDiffString(text, nextText)
  const textDelta = delta.create()
  if (index > 0) textDelta.retain(index)
  if (remove > 0) textDelta.delete(remove)
  if (insert.length > 0) textDelta.insert(insert)
  if (index > 0 || remove > 0 || insert.length > 0) {
    ytext.applyDelta(textDelta.done(), attributionManager)
  }
  const formatDelta = delta.create()
  content.forEach(part => {
    if (part.insert.length > 0) {
      formatDelta.retain(part.insert.length, part.attrs)
    }
  })
  if (nextText.length > 0) {
    ytext.applyDelta(formatDelta.done(), attributionManager)
  }
}

const syncElementAttrs = (yelement, pnode, attributionManager) => {
  const yattrs = Object.fromEntries(yelement.attrEntries())
  const d = delta.create(yelement.name)
  let changed = false
  Object.keys(pnode.attrs).forEach(key => {
    if (key === 'ychange') return
    const value = pnode.attrs[key]
    if (value == null) {
      if (yattrs[key] !== undefined) {
        d.deleteAttr(key)
        changed = true
      }
      return
    }
    if (!equalAttrs(yattrs[key], value)) {
      d.setAttr(key, value)
      changed = true
    }
  })
  Object.keys(yattrs).forEach(key => {
    if (pnode.attrs[key] === undefined) {
      d.deleteAttr(key)
      changed = true
    }
  })
  if (changed) {
    yelement.applyDelta(d.done(), attributionManager)
  }
}

const equalYTextPText = (ytext, ptexts) => {
  const ydelta = Array.from(ytext.toDelta())
  const pdelta = ptexts.map(ptext => ({
    insert: ptext.text ?? '',
    attrs: marksToAttributes(ptext.marks)
  }))
  if (ydelta.length !== pdelta.length) return false
  return ydelta.every((op, index) =>
    op.insert === pdelta[index].insert &&
    equalAttrs(op.attributes || op.format || {}, pdelta[index].attrs)
  )
}

const equalYTypePNode = (ytype, pnode) => {
  if (ytype instanceof Y.Type && ytype.name != null && !Array.isArray(pnode) && ytype.name === pnode.type.name) {
    const pchildren = normalizePNodeContent(pnode)
    const ychildren = ytype.toArray()
    return equalAttrs(Object.fromEntries(ytype.attrEntries()), pnode.attrs) &&
      ychildren.length === pchildren.length &&
      ychildren.every((child, index) => equalYTypePNode(child, pchildren[index]))
  }
  return ytype instanceof Y.Type && ytype.name == null && Array.isArray(pnode) && equalYTextPText(ytype, pnode)
}

const updateYFragment = (yDomFragment, pnode, attributionManager) => {
  if (yDomFragment instanceof Y.Type && yDomFragment.name != null) {
    if (Array.isArray(pnode) || yDomFragment.name !== pnode.type.name) {
      throw new Error('node name mismatch')
    }
    syncElementAttrs(yDomFragment, pnode, attributionManager)
  }

  const pChildren = Array.isArray(pnode) ? pnode : normalizePNodeContent(pnode)
  let yChildren = yDomFragment.toArray()
  let left = 0
  let right = 0

  while (left < yChildren.length && left < pChildren.length) {
    const yChild = yChildren[left]
    const pChild = pChildren[left]
    if (yChild instanceof Y.Type && yChild.name == null && Array.isArray(pChild)) {
      updateYText(yChild, pChild, attributionManager)
      left++
      continue
    }
    if (yChild instanceof Y.Type && yChild.name != null && !Array.isArray(pChild) && yChild.name === pChild.type.name) {
      updateYFragment(yChild, pChild, attributionManager)
      left++
      continue
    }
    break
  }

  while (right + left < yChildren.length && right + left < pChildren.length) {
    const yChild = yChildren[yChildren.length - right - 1]
    const pChild = pChildren[pChildren.length - right - 1]
    if (equalYTypePNode(yChild, pChild)) {
      right++
      continue
    }
    break
  }

  while (yChildren.length - left - right > 0 && pChildren.length - left - right > 0) {
    yDomFragment.delete(left, 1)
    yDomFragment.insert(left, [createTypeFromTextOrElementNode(pChildren[left], attributionManager)])
    left++
    yChildren = yDomFragment.toArray()
  }

  const yDelLen = yChildren.length - left - right
  if (yChildren.length === 1 && pChildren.length === 0 && yChildren[0] instanceof Y.Type && yChildren[0].name == null) {
    yChildren[0].delete(0, yChildren[0].length)
  } else if (yDelLen > 0) {
    yDomFragment.delete(left, yDelLen)
  }
  if (left + right < pChildren.length) {
    const ins = []
    for (let i = left; i < pChildren.length - right; i++) {
      ins.push(createTypeFromTextOrElementNode(pChildren[i], attributionManager))
    }
    yDomFragment.insert(left, ins)
  }
}

export const syncPmDocToYFragment = (fragment, pdoc, { attributionManager = Y.noAttributionsManager } = {}) => {
  updateYFragment(fragment, pdoc, attributionManager)
  return fragment
}

const comparableAttrEntries = attrs =>
  Object.entries(attrs ?? {}).filter(([key]) => key !== 'id' && key !== 'ychange')

const equalComparableAttrs = (beforeAttrs, afterAttrs) => {
  const beforeEntries = comparableAttrEntries(beforeAttrs)
  const afterEntries = comparableAttrEntries(afterAttrs)
  return (
    beforeEntries.length === afterEntries.length &&
    beforeEntries.every(([key, value]) => equalAttrs(value, afterAttrs?.[key]))
  )
}

const yNodeTextToStringAndAttrs = ynode => {
  let text = ''
  const attrs = {}
  for (const op of ynode.toDelta().children) {
    if (delta.$textOp.check(op)) {
      text += op.insert
    }
    Object.keys(op.attributes || op.format || {}).forEach(key => {
      attrs[key] = null
    })
  }
  return { text, attrs }
}

const createReplacementType = (pnode, attributionManager) => {
  return Y.Type.from(nodeToDelta(pnode).done())
}

const updateYInlineType = (ynode, pnode, attributionManager) => {
  syncElementAttrs(ynode, pnode, attributionManager)
  const ptexts = /** @type {Array<import('prosemirror-model').Node>} */ (pnode.content.content.filter(child => child.isText))
  const { text, attrs: nullAttrs } = yNodeTextToStringAndAttrs(ynode)
  const content = ptexts.map(ptext => ({
    insert: ptext.text ?? '',
    attrs: Object.assign({}, nullAttrs, marksToAttributes(ptext.marks))
  }))
  const nextText = content.map(c => c.insert).join('')
  const { index, remove, insert } = simpleDiffString(text, nextText)
  const textDelta = delta.create()
  if (index > 0) textDelta.retain(index)
  if (remove > 0) textDelta.delete(remove)
  if (insert.length > 0) textDelta.insert(insert)
  if (index > 0 || remove > 0 || insert.length > 0) {
    ynode.applyDelta(textDelta.done(), attributionManager)
  }
  const formatDelta = delta.create()
  content.forEach(part => {
    if (part.insert.length > 0) {
      formatDelta.retain(part.insert.length, part.attrs)
    }
  })
  if (nextText.length > 0) {
    ynode.applyDelta(formatDelta.done(), attributionManager)
  }
}

const syncStructuralChildren = (yParent, beforeNode, afterNode, attributionManager) => {
  syncElementAttrs(yParent, afterNode, attributionManager)

  if (afterNode.inlineContent) {
    updateYInlineType(yParent, afterNode, attributionManager)
    return
  }

  const commonChildCount = math.min(beforeNode.childCount, afterNode.childCount)

  for (let i = 0; i < commonChildCount; i++) {
    const beforeChild = beforeNode.child(i)
    const afterChild = afterNode.child(i)

    if (
      beforeChild.type.name !== afterChild.type.name ||
      !equalComparableAttrs(beforeChild.attrs, afterChild.attrs)
    ) {
      yParent.delete(i, 1)
      yParent.insert(i, [createReplacementType(afterChild, attributionManager)])
      continue
    }

      const yChild = yParent.toArray()[i]
      if (
        yChild instanceof Y.Type &&
        !beforeChild.isText &&
        !afterChild.isText
      ) {
        syncStructuralChildren(yChild, beforeChild, afterChild, attributionManager)
      }
  }

  if (beforeNode.childCount > afterNode.childCount) {
    yParent.delete(afterNode.childCount, beforeNode.childCount - afterNode.childCount)
  } else if (afterNode.childCount > beforeNode.childCount) {
    const insertedChildren = []
    for (let i = beforeNode.childCount; i < afterNode.childCount; i++) {
      insertedChildren.push(createReplacementType(afterNode.child(i), attributionManager))
    }
    yParent.insert(beforeNode.childCount, insertedChildren)
  }
}

export const syncStructuralChangesToYFragment = (fragment, beforeDoc, afterDoc, {
  attributionManager = Y.noAttributionsManager
} = {}) => {
  syncStructuralChildren(fragment, beforeDoc, afterDoc, attributionManager)
  return fragment
}

const normalizeDeltaAttrs = attrs => {
  if (attrs == null) {
    return []
  }
  if (Array.isArray(attrs)) {
    return attrs
  }
  if (typeof attrs[Symbol.iterator] === 'function') {
    return Array.from(attrs)
  }
  return Object.entries(attrs).map(([key, value]) =>
    value != null && typeof value === 'object' && !Array.isArray(value)
      ? { key, ...value }
      : { key, value }
  )
}

const normalizeDeltaChildren = children => {
  if (children == null) {
    return []
  }
  if (Array.isArray(children)) {
    return children
  }
  if (typeof children[Symbol.iterator] === 'function') {
    return Array.from(children)
  }
  return []
}

const getChildOpType = op => {
  if (delta.$retainOp.check(op)) return 'retain'
  if (delta.$modifyOp.check(op)) return 'modify'
  if (delta.$insertOp.check(op)) return 'insert'
  if (delta.$textOp.check(op)) return 'text'
  if (delta.$deleteOp.check(op)) return 'delete'
  if (op?.type === 'retain') return 'retain'
  if (op?.type === 'modify') return 'modify'
  if (op?.type === 'insert') {
    return typeof op.insert === 'string' ? 'text' : 'insert'
  }
  if (typeof op?.delete === 'number' || op?.type === 'delete') return 'delete'
  return null
}

const getAttrOpType = op => {
  if (delta.$setAttrOp.check(op)) return 'set'
  if (delta.$deleteAttrOp.check(op)) return 'delete'
  if (delta.$modifyAttrOp.check(op)) return 'modify'
  if (op?.type === 'insert') return 'set'
  if (op?.type === 'delete') return 'delete'
  if (op?.type === 'modify') return 'modify'
  return null
}

/**
 * @param {import('prosemirror-transform').Transform} tr
 * @param {ProsemirrorDelta} d
 * @param {Node} [pnode]
 * @param {{ i: number }} [currPos]
 * @return {import('prosemirror-transform').Transform}
 */
export const deltaToPSteps = (tr, d, pnode = tr.doc, currPos = { i: 0 }) => {
  const schema = tr.doc.type.schema
  let currParentIndex = 0
  let nOffset = 0
  const pchildren = pnode.children
  for (const attr of normalizeDeltaAttrs(d.attrs)) {
    const nodePos = currPos.i - 1
    const targetNode = nodePos >= 0 ? tr.doc.nodeAt(nodePos) : null
    // ProseMirror text nodes don't support attrs, and collaborative
    // undo/diff paths can still surface attribute changes for nodes that
    // were already deleted or shifted away. Ignore those invalid attr
    // applications instead of crashing mid-sync.
    if (getAttrOpType(attr) === 'set' && targetNode != null && !targetNode.isText) {
      tr.setNodeAttribute(nodePos, attr.key, attr.value)
    }
  }
  const children = normalizeDeltaChildren(d.children)
  for (let opIndex = 0; opIndex < children.length; opIndex++) {
    const op = children[opIndex]
    const opType = getChildOpType(op)
    const nextOp = children[opIndex + 1]
    const nextOpType = getChildOpType(nextOp)
    if (
      opType === 'delete' &&
      nextOpType === 'insert' &&
      op.delete === 1
    ) {
      const pc = pchildren[currParentIndex]
      if (pc !== undefined && !pc.isText) {
        const newPChildren = nextOp.insert.map(ins => deltaToPNode(ins, schema, nextOp.format))
        tr.replaceWith(currPos.i, currPos.i + pc.nodeSize, newPChildren)
        currParentIndex++
        currPos.i += newPChildren.reduce((s, c) => c.nodeSize + s, 0)
        opIndex++
        continue
      }
    }
    if (opType === 'retain') {
      // skip over i children
      let i = op.retain
      while (i > 0) {
        const pc = pchildren[currParentIndex]
        if (pc === undefined) {
          throw new Error('[y/prosemirror]: retain operation is out of bounds')
        }
        if (pc.isText) {
          if (op.format != null) {
            const from = currPos.i
            const to = currPos.i + math.min(pc.nodeSize - nOffset, i)
            object.forEach(op.format, (v, k) => {
              if (v == null) {
                tr.removeMark(from, to, schema.marks[k])
              } else {
                tr.addMark(from, to, schema.mark(k, v))
              }
            })
          }
          if (i + nOffset < pc.nodeSize) {
            nOffset += i
            currPos.i += i
            i = 0
          } else {
            currParentIndex++
            i -= pc.nodeSize - nOffset
            currPos.i += pc.nodeSize - nOffset
            nOffset = 0
          }
        } else {
          object.forEach(op.format ?? {}, (v, k) => {
            if (v == null) {
              tr.removeNodeMark(currPos.i, schema.marks[k])
            } else {
              // TODO see schema.js for more info on marking nodes
              tr.addNodeMark(currPos.i, schema.mark(k, v))
            }
          })
          currParentIndex++
          currPos.i += pc.nodeSize
          i--
        }
      }
    } else if (opType === 'modify') {
      currPos.i++
      deltaToPSteps(tr, op.value, pchildren[currParentIndex++], currPos)
      currPos.i++
    } else if (opType === 'insert') {
      const newPChildren = op.insert.map(ins => deltaToPNode(ins, schema, op.format))
      tr.insert(currPos.i, newPChildren)
      currPos.i += newPChildren.reduce((s, c) => c.nodeSize + s, 0)
    } else if (opType === 'text') {
      tr.insert(currPos.i, schema.text(op.insert, formattingAttributesToMarks(op.format, schema)))
      currPos.i += op.insert.length
    } else if (opType === 'delete') {
      for (let remainingDelLen = op.delete; remainingDelLen > 0;) {
        const pc = pchildren[currParentIndex]
        if (pc === undefined) {
          throw new Error('[y/prosemirror]: delete operation is out of bounds')
        }
        if (pc.isText) {
          const delLen = math.min(pc.nodeSize - nOffset, remainingDelLen)
          tr.delete(currPos.i, currPos.i + delLen)
          nOffset += delLen
          if (nOffset === pc.nodeSize) {
            // TODO this can't actually "jump out" of the current node
            // jump to next node
            nOffset = 0
            currParentIndex++
          }
          remainingDelLen -= delLen
        } else {
          tr.delete(currPos.i, currPos.i + pc.nodeSize)
          currParentIndex++
          remainingDelLen--
        }
      }
    } else {
      error.unexpectedCase()
    }
  }
  return tr
}

/**
 * @param {ProsemirrorDelta} d
 * @param {import('prosemirror-model').Schema} schema
 * @param {delta.FormattingAttributes|null} dformat
 * @return {Node}
 */
const deltaToPNode = (d, schema, dformat) => {
  /**
   * @type {Object<string,any>}
   */
  const attrs = {}
  for (const attr of d.attrs) {
    attrs[attr.key] = attr.value
  }
  const dc = d.children.map(c => delta.$insertOp.check(c) ? c.insert.map(cn => deltaToPNode(cn, schema, c.format)) : (delta.$textOp.check(c) ? [schema.text(c.insert, formattingAttributesToMarks(c.format, schema))] : []))
  return schema.node(d.name, attrs, dc.flat(1), formattingAttributesToMarks(dformat, schema))
}

/**
 * @param {Node} beforeDoc
 * @param {Node} afterDoc
 */
export const docDiffToDelta = (beforeDoc, afterDoc) => {
  const initialDelta = nodeToDelta(beforeDoc)
  const finalDelta = nodeToDelta(afterDoc)

  return delta.diff(initialDelta.done(), finalDelta.done())
}

/**
 * @param {Transform} tr
 */
export const trToDelta = (tr) => {
  const initialDelta = nodeToDelta(tr.before)
  const finalDelta = nodeToDelta(tr.doc)
  return delta.diff(initialDelta.done(), finalDelta.done())
}

const _stepToDelta = s.match({ beforeDoc: Node, afterDoc: Node })
  .if([ReplaceStep, ReplaceAroundStep], (step, { beforeDoc, afterDoc }) => {
    const oldStart = beforeDoc.resolve(step.from)
    const oldEnd = beforeDoc.resolve(step.to)
    const newStart = afterDoc.resolve(step.from)

    const newEnd = afterDoc.resolve(step instanceof ReplaceAroundStep ? step.getMap().map(step.to) : step.from + step.slice.size)

    const oldBlockRange = oldStart.blockRange(oldEnd)
    const newBlockRange = newStart.blockRange(newEnd)
    const oldDelta = deltaForBlockRange(oldBlockRange)
    const newDelta = deltaForBlockRange(newBlockRange)
    const diffD = delta.diff(oldDelta, newDelta)
    const stepDelta = deltaModifyNodeAt(beforeDoc, oldBlockRange?.start || newBlockRange?.start || 0, d => { d.append(diffD) })
    return stepDelta
  })
  .if(AddMarkStep, (step, { beforeDoc }) =>
    deltaModifyNodeAt(beforeDoc, step.from, d => { d.retain(step.to - step.from, marksToFormattingAttributes([step.mark])) })
  )
  .if(AddNodeMarkStep, (step, { beforeDoc }) =>
    deltaModifyNodeAt(beforeDoc, step.pos, d => { d.retain(1, marksToFormattingAttributes([step.mark])) })
  )
  .if(RemoveMarkStep, (step, { beforeDoc }) =>
    deltaModifyNodeAt(beforeDoc, step.from, d => { d.retain(step.to - step.from, { [step.mark.type.name]: null }) })
  )
  .if(RemoveNodeMarkStep, (step, { beforeDoc }) =>
    deltaModifyNodeAt(beforeDoc, step.pos, d => { d.retain(1, { [step.mark.type.name]: null }) })
  )
  .if(AttrStep, (step, { beforeDoc }) =>
    deltaModifyNodeAt(beforeDoc, step.pos, d => { d.modify(delta.create().setAttr(step.attr, step.value)) })
  )
  .if(DocAttrStep, step =>
    delta.create().setAttr(step.attr, step.value)
  )
  .else(_step => {
    // unknown step kind
    error.unexpectedCase()
  })
  .done()

/**
 * @param {import('prosemirror-transform').Step} step
 * @param {import('prosemirror-model').Node} beforeDoc
 * @return {ProsemirrorDelta}
 */
export const stepToDelta = (step, beforeDoc) => {
  const stepResult = step.apply(beforeDoc)
  if (stepResult.failed) {
    throw new Error('[y/prosemirror]: step failed to apply')
  }
  return _stepToDelta(step, { beforeDoc, afterDoc: /** @type {Node} */ (stepResult.doc) })
}

/**
 *
 * @param {import('prosemirror-model').NodeRange | null} blockRange
 */
function deltaForBlockRange (blockRange) {
  if (blockRange === null) {
    return delta.create()
  }
  const { startIndex, endIndex, parent } = blockRange
  return nodesToDelta(parent.content.content.slice(startIndex, endIndex))
}

/**
 * This function is used to find the delta offset for a given prosemirror offset in a node.
 * Given the following document:
 * <doc><p>Hello world</p><blockquote><p>Hello world!</p></blockquote></doc>
 * The delta structure would look like this:
 *  0: p
 *   - 0: text("Hello world")
 *  1: blockquote
 *   - 0: p
 *     - 0: text("Hello world!")
 * So the prosemirror position 10 would be within the delta offset path: 0, 0 and have an offset into the text node of 9 (since it is the 9th character in the text node).
 *
 * So the return value would be [0, 9], which is the path of: p, text("Hello wor")
 *
 * @param {Node} node
 * @param {number} searchPmOffset The p offset to find the delta offset for
 * @return {number[]} The delta offset path for the search pm offset
 */
export function pmToDeltaPath (node, searchPmOffset = 0) {
  if (searchPmOffset === 0) {
    // base case
    return [0]
  }

  const resolvedOffset = node.resolve(searchPmOffset)
  const depth = resolvedOffset.depth
  const path = []
  if (depth === 0) {
    // if the offset is at the root node, return the index of the node
    return [resolvedOffset.index(0)]
  }
  // otherwise, add the index of each parent node to the path
  for (let d = 0; d < depth; d++) {
    path.push(resolvedOffset.index(d))
  }

  // add any offset into the parent node to the path
  path.push(resolvedOffset.parentOffset)

  return path
}

/**
 * Inverse of {@link pmToDeltaPath}
 * @param {number[]} deltaPath
 * @param {Node} node
 * @return {number} The prosemirror offset for the delta path
 */
export function deltaPathToPm (deltaPath, node) {
  let pmOffset = 0
  let curNode = node

  // Special case: if path has only one element, it's a child index at depth 0
  if (deltaPath.length === 1) {
    const childIndex = deltaPath[0]
    // Add sizes of all children before the target index
    for (let j = 0; j < childIndex; j++) {
      pmOffset += curNode.children[j].nodeSize
    }
    return pmOffset
  }

  // Handle all elements except the last (which is an offset)
  for (let i = 0; i < deltaPath.length - 1; i++) {
    const childIndex = deltaPath[i]
    // Add sizes of all children before the target child
    for (let j = 0; j < childIndex; j++) {
      pmOffset += curNode.children[j].nodeSize
    }
    // Add 1 for the opening tag of the target child, then navigate into it
    pmOffset += 1
    curNode = curNode.children[childIndex]
  }

  // Last element is an offset within the current node
  pmOffset += deltaPath[deltaPath.length - 1]

  return pmOffset
}

/**
 * @param {Node} node
 * @param {number} pmOffset
 * @param {(d:delta.DeltaBuilderAny)=>any} mod
 * @return {ProsemirrorDelta}
 */
export const deltaModifyNodeAt = (node, pmOffset, mod) => {
  const dpath = pmToDeltaPath(node, pmOffset)
  let currentOp = delta.create($prosemirrorDelta)
  const lastIndex = dpath.length - 1
  currentOp.retain(lastIndex >= 0 ? dpath[lastIndex] : 0)
  mod(currentOp)
  for (let i = lastIndex - 1; i >= 0; i--) {
    currentOp = /** @type {delta.DeltaBuilderAny} */ (delta.create($prosemirrorDelta).retain(dpath[i]).modify(currentOp))
  }
  return currentOp
}
