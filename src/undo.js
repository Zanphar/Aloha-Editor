/* undo.js is part of Aloha Editor project http://aloha-editor.org
 *
 * Aloha Editor is a WYSIWYG HTML5 inline editing library and editor.
 * Copyright (c) 2010-2013 Gentics Software GmbH, Vienna, Austria.
 * Contributors http://aloha-editor.org/contribution.php
 */
define([
	'arrays',
	'maps',
	'dom',
	'boundaries',
	'functions',
	'traversing',
	'ranges',
	'assert'
], function Undo(
	Arrays,
	Maps,
	Dom,
	Boundaries,
	Fn,
	Traversing,
	Ranges,
	Assert
) {
	'use strict'

	/**
	 * Creates a new undo context.
	 *
	 * The undo context holds an assortment of data items used across
	 * many of the undo functions.
	 *
	 * Should be treated as a black box.
	 *
	 * @param elem {Element}
	 *        The element whose mutations to are to be observed and made
	 *        undoable/redoable.
	 * @param opts {Object.<string,*>}
	 *        A map of options:
	 *        noMutationObserver - whether or not to use the MutationObserver
	 *          API to observe changes,
	 *        maxCombineChars - how many character to combine to a
	 *          single change (default 20).
	 *        maxHistory - how many items to keep in the history
	 *          (default 1000).
	 * @return {Undo}
	 */
	function Context(elem, opts) {
		opts = Maps.merge({
			maxCombineChars: 20,
			maxHistory: 1000
		}, opts);
		var context = {
			elem: elem,
			observer: null,
			stack: [],
			frame: null,
			opts: opts,
			history: [],
			historyIndex: 0
		};
		context.observer = (!opts.noMutationObserver && window.MutationObserver
		                    ? ChangeObserverUsingMutationObserver()
		                    : ChangeObserverUsingSnapshots());
		return context;
	}

	/**
	 * Creates a changeSet.
	 *
	 * @param meta {*} the metadat of the changeSet
	 * @param changes {Array.<Change>} an array of changes
	 * @param selection {RangeUpdateChange} reflects the change of the
	 *        range from before to after all changes in this changeSet.
	 * @return {ChangeSet}
	 */
	function makeChangeSet(meta, changes, selection) {
		return {
			changes: changes,
			meta: meta,
			selection: selection
		};
	}

	/**
	 * Whether two paths are equal.
	 *
	 * @param pathA {Path}
	 * @param pathB {Path}
	 * @return {boolean}
	 */
	function pathEquals(pathA, pathB) {
		return Arrays.equal(pathA, pathB, Arrays.equal);
	}

	function stepDownPath(path, containerName, off) {
		path.push([off, containerName]);
	}

	/**
	 * Creates a path from the given container down to the given node.
	 *
	 * @param container {Element}
	 * @param container {Node}
	 * @return {Path}
	 */
	function nodePath(container, node) {
		var path = [];
		while (node && container !== node) {
			var parent = node.parentNode;
			if (!parent) {
				return null;
			}
			stepDownPath(path, parent.nodeName, Dom.normalizedNodeIndex(node));
			node = parent;
		}
		path.reverse();
		return path;
	}

	/**
	 * Creates a boundary from the given path in the given container.
	 *
	 * @param container {Element} at which the path begins.
	 * @param path {Path} which goes down from the given container to the boundary.
	 * @return {Boundary} the boundary at the given path.
	 */
	function boundaryFromPath(container, path) {
		for (var i = 0; i < path.length - 1; i++) {
			var step = path[i];
			Assert.assertEqual(step[1], container.nodeName);
			container = Dom.normalizedNthChild(container, step[0]);
		}
		var lastStep = Arrays.last(path);
		var off = lastStep[0];
		container = Traversing.nextWhile(container, Dom.isEmptyTextNode);
		// NB: container must be non-null at this point.
		Assert.assertEqual(lastStep[1], container.nodeName);
		if (Dom.isTextNode(container)) {
			// Because text offset paths with value 0 are invalid.
			Assert.assertNotEqual(off, 0);
			while (off > Dom.nodeLength(container)) {
				Assert.assertTrue(Dom.isTextNode(container));
				off -= Dom.nodeLength(container);
				container = container.nextSibling;
			}
			// Because we may have stepped out of a text node.
			if (!Dom.isTextNode(container)) {
				Assert.assertEqual(off, 0);
				container = container.parentNode;
				off = Dom.nodeIndex(container);
			}
		} else {
			off = Dom.realFromNormalizedIndex(container, off);
		}
		return Dom.normalizeBoundary([container, off]);
	}

	/**
	 * Creates a path from a boundary.
	 *
	 * A path is an array of arrays where each member represents the
	 * offset of a child in a parent. The empty array represents the
	 * path of the top-most container from which the path was
	 * calculated.
	 *
	 * The last step in a path may be the offset in a text node.
	 *
	 * If the nodes before a boundary are text nodes, the last step will
	 * always be the offset in a text node, and the combined length of
	 * the text nodes before the boundary will be used as the
	 * offset. This is true even if the node following the boundary is
	 * not a text node, and the path could theoretically be represented
	 * by the next node's offset in the element parent. That's because
	 * the path represents the path in the DOM based on the normalized
	 * number of previous siblings, and doesn't depend on any next
	 * siblings, and if we didn't always include the text offset before
	 * the path, the path would look different if constructed from a DOM
	 * that is structurally equal before the boundary, but contains text
	 * nodes directly after the boundary.
	 *
	 * Paths with textOff = 0 are invalid because empty text nodes
	 * should be treated as if they are not present and if a path in an
	 * empty text node is taken, the same path would become invalid when
	 * the empty text node is removed. This is true even when the text
	 * node is not empty because we can't depend on what occurs after
	 * the boundary (see previous paragraph).
	 *
	 * Paths reflect the normalized DOM - offsets will be calculated
	 * assuming that empty text nodes don't exist and that subsequent
	 * text nodes are counted as one.
	 *
	 * @param container {Element}
	 *        The container from which to start calculating the path.
	 *        Must contain the given boundary.
	 * @param boundary {Boundary}
	 *        Must be contained by the given container
	 * @return {Path}
	 *        The path from the given container to the given boundary.
	 */
	function pathFromBoundary(container, boundary) {
		boundary = Dom.normalizeBoundary(boundary);
		var path;
		var textOff = Boundaries.precedingTextLength(boundary);
		if (textOff) {
			var node = Boundaries.nodeBefore(boundary);
			// Because nodePath() would use the normalizedNodeIndex
			// which would translate an empty text node after a
			// non-empty text node to the normalized offset after the
			// non-empty text node.
			node = Traversing.prevWhile(node, Dom.isEmptyTextNode);
			path = nodePath(container, node);
			stepDownPath(path, '#text', textOff);
		} else if (Boundaries.atEnd(boundary)) {
			var boundaryContainer = boundary[0];
			path = nodePath(container, boundaryContainer);
			var numChildren = Dom.normalizedNumChildren(boundaryContainer);
			stepDownPath(path, boundaryContainer.nodeName, numChildren);
		} else {
			path = nodePath(container, Boundaries.nodeAfter(boundary));
		}
		return path;
	}

	/**
	 * Create a path from the given container to immediately before the
	 * given node.
	 */
	function pathBeforeNode(container, node) {
		return pathFromBoundary(container, Boundaries.beforeNode(node));
	}

	function recordRange(container, range) {
		if (!range) {
			return null;
		}
		var start = pathFromBoundary(container, Boundaries.start(range));
		var end = pathFromBoundary(container, Boundaries.end(range));
		return start && end ? {start: start, end: end} : null;
	}

	function takeRecords(context, frame) {
		if (frame.opts.noObserve) {
			context.observer.discardChanges();
		} else {
			var changes = context.observer.takeChanges();
			if (changes.length) {
				frame.records.push({changes: changes});
			}
		}
	}

	function partitionRecords(context, leavingFrame, lowerFrame, upperFrame) {
		if ((upperFrame.opts.partitionRecords && !upperFrame.opts.noObserve)
		    || (!!lowerFrame.opts.noObserve !== !!upperFrame.opts.noObserve)) {
			takeRecords(context, leavingFrame);
		}
	}

	function close(context) {
		if (context.frame) {
			context.observer.disconnect()
			context.frame = null;
		}
	}

	/**
	 * Enters a new frame in the given undo context.
	 * 
	 * @param context {Undo}
	 * @param opts {Object.<string,*>}
	 *        A map of options:
	 *        noObserve - whether to observe changes. If true, changes
	 *          must be supplied via the result argument of leave().
	 *          Applies recursively to all nested frames.
	 *        partitionRecords - whether to split up changes happening
	 *          inside this frame and frames direcly below this frame (but
	 *          not deeper).
	 *        oldRange - a range to record that reflects the range
	 *          before any changes in this frame happen.
	 * @return {void}
	 */
	function enter(context, opts) {
		opts = opts || {};
		var upperFrame = context.frame;
		var observer = context.observer;
		var elem = context.elem;
		var noObserve = opts.noObserve || (upperFrame && upperFrame.opts.noObserve);
		var frame = {
			opts: Maps.merge(opts, {noObserve: noObserve}),
			records: [],
			oldRange: recordRange(elem, opts.oldRange),
			newRange: null
		};
		if (upperFrame) {
			partitionRecords(context, upperFrame, frame, upperFrame);
			context.stack.push(upperFrame);
		} else {
			observer.observeAll(elem);
		}
		context.frame = frame;
	}

	/**
	 * Leave a frame in the given undo context.
	 *
	 * @param context {Undo}
	 * @param result {Object.<string.*>}
	 * @return {Frame}
	 */
	function leave(context, result) {
		var frame = context.frame;
		var observer = context.observer;
		var upperFrame = context.stack.pop();;
		if (upperFrame) {
			partitionRecords(context, frame, frame, upperFrame);
		} else {
			takeRecords(context, frame);
			close(context);
		}
		var noObserve = frame.opts.noObserve;
		// Because we expect either a result to be returned by the
		// capture function, or observed by the observer, but not both.
		Assert.assertFalse(!!(!noObserve && result && result.changes));
		if (noObserve && result && result.changes && result.changes.length) {
			frame.records.push({changes: result.changes});
		}
		frame.newRange = recordRange(context.elem, result && result.newRange);
		if (upperFrame) {
			upperFrame.records.push({frame: frame});
			context.frame = upperFrame;
		}
		return frame;
	}

	/**
	 * Enter/leave a frame before/after calling the given function.
	 *
	 * @param context {Undo}
	 * @param opts {Object.<string,*>} given as the opts argument to enter()
	 * @param {function(void):{Object.<string,*>}} given as the result argument to leave()
	 * @return {Frame} the captured frame
	 */
	function capture(context, opts, fn) {
		enter(context, opts);
		var result;
//		try {
			result = fn();
//		} catch (e) {
			// TODO for some reason, whether I rethrow here or if I
			// remove the catch (but not the try{}finally{}) completely,
			// my version of Chrome just ignores the exception. Maybe
			// it's a bug that just happens in the version of Chrome I'm
			// using?
//			window.console && window.console.log(e);
//			throw e;
//		} finally {
			return leave(context, result);
//		}
	}

	function captureOffTheRecord(context, opts, fn) {
		var frame = capture(context, Maps.merge(opts, {noObserve: true}), fn);
		// Because leave() will push the captured frame onto the
		// upperFrame.
		var upperFrame = context.frame;
		if (upperFrame) {
			upperFrame.records.pop();
		}
		return frame;
	}

	function makeInsertDeleteChange(type, path, content) {
		return {
			type: type,
			path: path,
			content: content
		};
	}

	function makeInsertChange(path, content) {
		return makeInsertDeleteChange('insert', path, content);
	}

	function makeDeleteChange(path, content) {
		return makeInsertDeleteChange('delete', path, content);
	}

	function makeUpdateAttrChange(path, node, recordAttrs) {
		var attrs = [];
		Maps.forEach(recordAttrs, function (attr) {
			var name = attr.name;
			var ns = attr.ns;
			attrs.push({
				name: name,
				ns: ns,
				oldValue: attr.oldValue,
				newValue: Dom.getAttrNS(node, ns, name)
			});
		});
		return {
			type: 'update-attr',
			path: path,
			attrs: attrs
		};
	}

	function makeRangeUpdateChange(oldRange, newRange) {
		return {
			type: 'update-range',
			oldRange: oldRange,
			newRange: newRange
		};
	}

	var INSERT = 0;
	var UPDATE_ATTR = 1;
	var UPDATE_TEXT = 2;
	var DELETE_FLAG = 4;
	var DELETE = DELETE_FLAG;
	var COMPOUND_DELETE = DELETE_FLAG + 1;

	function makeDelete(node, target, prevSibling) {
		return {
			type: DELETE,
			node: node,
			target: target,
			prevSibling: prevSibling,
			contained: [],
			updateAttr: null,
			updateText: null
		};
	}

	function makeMultiDelete(delRecords, target, prevSibling) {
		return {
			type: COMPOUND_DELETE,
			records: delRecords,
			target: target,
			prevSibling: prevSibling
		};
	}

	function makeInsert(node) {
		return {type: INSERT, node: node, contained: []};
	}

	function makeUpdateAttr(node, attrs) {
		return {type: UPDATE_ATTR, node: node, attrs: {}};
	}

	function makeUpdateText(node, oldValue) {
		return {type: UPDATE_TEXT, node: node, oldValue: oldValue};
	}

	function anchorNode(record) {
		if (DELETE_FLAG & record.type) {
			return record.prevSibling || record.target;
		} else {
			return record.node;
		}
	}

	// NB: All insert-delete sequences in this table are no-ops:
	// insert-delete               => no-op
	// insert-delete-insert        => insert (in inserted)
	// insert-delete-insert-delete => no-op
	// delete-insert               => move   (in delsBy*, inserted)
	// delete-insert-delete        => delete (in delsBy*)
	// delete-insert-delete-insert => move   (in delsBy*, inserted)
	function normalizeInsertDeletePreserveAnchors(moves, inserted, delsByPrevSibling, delsByTarget) {
		moves.forEach(function (move) {
			var node = move.node;
			var id = Dom.ensureExpandoId(node);
			var type = move.type;
			if (DELETE === type) {
				var prevSibling = move.prevSibling;
				var target = move.target;
				var ref = prevSibling ? prevSibling : target;
				var map = prevSibling ? delsByPrevSibling : delsByTarget;
				var refId = Dom.ensureExpandoId(ref);
				var dels = map[refId] = map[refId] || [];

				if (inserted[id]) {
					// Because an insert-delete sequence will become a
					// no-op, and we just pretend that it didn't happen.
					delete inserted[id];
				} else {
					dels.push(move);
				}

				// Because it may be that the deleted node is the
				// prevSibling reference of a previous delete.
				var delsHavingRefs = delsByPrevSibling[id];
				if (delsHavingRefs) {
					delete delsByPrevSibling[id];
					// Because by eliminating delete-inserts above we
					// may have eliminated the first delete in the
					// delete sequence that must have a valid anchor.
					if (!dels.length && delsHavingRefs.length) {
						var refDel = delsHavingRefs[0];
						refDel.prevSibling = prevSibling;
						refDel.target = target;
					}
					map[refId] = dels.concat(delsHavingRefs);
				}
			} else if (INSERT === type) {
				Assert.assertFalse(!!inserted[id]);
				inserted[id] =  move;
			} else {
				// NB: moves should only contains INSERTs and DELETEs
				// (not COMPOUND_DELETEs).
				Assert.assertError();
			}
		});
	}

	function records(record) {
		return (COMPOUND_DELETE === record.type) ? record.records : [record];
	}

	function nodeContainsRecord(containerNode, record) {
		return (((DELETE_FLAG & record.type) && containerNode === record.target)
		        || Dom.contains(containerNode, anchorNode(record)));
	}

	function containsRecord(recordA, recordB) {
		return nodeContainsRecord(recordA.node, recordB);
	}

	// Each delete is contained by not more than a single container
	// delete, if any.
	//
	// We only need inserts at the top-level, or inside deletes. Inserts
	// and deletes inside new inserts must be completely
	// ignored. Inserts and deletes inside delete-insert sequences must
	// be contained by the delete, but not by the insert.
	//
	// When all deletes are processed first, and then all inserts, the
	// insert of a delete-insert sequence would not contain any of the
	// inserts or deletes that happened in the delete, since the insert
	// of a delete-insert sequence doesn't contain the delete of the
	// delete-insert sequence.
	//
	// Given above, if an insert contains deletes, the insert is not
	// part of an delete-insert sequence, since the delete of the
	// delete-insert sequence already contains all the deletes, and the
	// deletes can be discarded.
	//
	// For the same reason, if an insert contains inserts, they can be
	// discarded in favor of the container insert.
	function intoRecordTree(tree, record) {
		var containerRecord;
		// Because we need all operations that happened inside deletions
		// in order to reconstruct the structure before deletion.
		containerRecord = Arrays.some(tree, function (containerRecord) {
			if (DELETE_FLAG & containerRecord.type) {
				return Arrays.some(records(containerRecord), function (containerRecord) {
					if (containsRecord(containerRecord, record)) {
						return containerRecord;
					}
				});
			}
		});
		if (containerRecord) {
			containerRecord.contained = intoRecordTree(containerRecord.contained, record);
			return tree;
		}
		// Because an insert already contains all necessary information,
		// we can just discard any records that occur in inserts. For
		// delete-insert sequences, we don't loose any information
		// because the deletes already have all been processed.
		containerRecord = Arrays.some(tree, function (containerRecord) {
			if (INSERT === containerRecord.type) {
				if (containsRecord(containerRecord, record)) {
					return containerRecord;
				}
			}
		});
		if (containerRecord) {
			return tree;
		}
		// Because we can assume that any other records are updates that
		// are disconnected from structural changes (deletes already
		// have consumed the updateAttr and updateText information and
		// inserts don't need any update information) it is sufficient
		// to just add them without checking whether they contain other
		// records.
		var type = record.type;
		if (INSERT === type || (DELETE_FLAG & type)) {
			records(record).forEach(function (containerRecord) {
				var notContained = [];
				tree.forEach(function (record) {
					if (containsRecord(containerRecord, record)) {
						// Because an insert already contains all
						// necessary information, we can just discard
						// all contained records.
						if (DELETE === containerRecord.type) {
							containerRecord.contained.push(record);
						}
					} else {
						notContained.push(record);
					}
				});
				tree = notContained;
			});
		}
		tree.push(record);
		return tree;
	}

	function sortRecordTree(tree) {
		tree.sort(function (recordA, recordB) {
			var anchorA = anchorNode(recordA);
			var anchorB = anchorNode(recordB);
			// Because a delete's anchor precedes it, an insert with the
			// same anchor as the del's node will always precede it.
			if (anchorA === anchorB) {
				return (DELETE_FLAG & recordB.type) ? -1 : 1;
			}
			return Dom.follows(anchorA, anchorB) ? -1 : 1;
		});
		tree.forEach(function (record) {
			if (record.contained) {
				sortRecordTree(record.contained);
			}
		});
	}

	function makeRecordTree(container, moves, updateAttr, updateText) {
		var delsByPrevSibling = {};
		var delsByTarget = {};
		var inserted = {};
		normalizeInsertDeletePreserveAnchors(moves, inserted, delsByPrevSibling, delsByTarget);
		var delss = Maps.vals(delsByPrevSibling).concat(Maps.vals(delsByTarget));
		// Because normalizeInsertDeletePreserveAnchors may cause empty
		// del arrays.
		delss = delss.filter(function (dels) {
			return dels.length;
		});
		function consumeUpdates(record) {
			var id = Dom.ensureExpandoId(record.node);
			if (DELETE === record.type) {
				record.updateAttr = updateAttr[id];
				record.updateText = updateText[id];
			}
			delete updateAttr[id];
			delete updateText[id];
		}
		var dels = delss.map(function (dels){
			var refDel = dels[0];
			dels.forEach(consumeUpdates);
			return makeMultiDelete(dels, refDel.target, refDel.prevSibling);
		});
		var inss = Maps.vals(inserted);
		inss.forEach(consumeUpdates);
		var recordTree = [];
		// NB: the order in which dels and inss and updates are added to
		// the tree is significant.
		recordTree = dels.reduce(intoRecordTree, recordTree);
		recordTree = inss.reduce(intoRecordTree, recordTree);
		recordTree = Maps.vals(updateAttr).reduce(intoRecordTree, recordTree);
		recordTree = Maps.vals(updateText).reduce(intoRecordTree, recordTree);
		recordTree = recordTree.filter(function (record) {
			return nodeContainsRecord(container, record);
		});
		sortRecordTree(recordTree);
		return recordTree;
	}

	function delPath(container, delRecord) {
		var prevSibling = delRecord.prevSibling;
		var path;
		if (prevSibling) {
			var off = Dom.nodeIndex(prevSibling) + 1;
			path = pathFromBoundary(container, [prevSibling.parentNode, off]);
		} else {
			var target = delRecord.target;
			path = pathFromBoundary(container, [target, 0]);
		}
		return path;
	}

	function reconstructNodeFromDelRecord(delRecord) {
		var node = delRecord.node;
		var reconstructedNode;
		if (Dom.isTextNode(node)) {
			var updateText = delRecord.updateText;
			if (updateText) {
				reconstructedNode = node.ownerDocument.createTextNode(updateText.oldValue);
			} else {
				reconstructedNode = Dom.clone(node);
			}
		} else {
			reconstructedNode = Dom.clone(node);
			var updateAttr = delRecord.updateAttr;
			if (updateAttr) {
				Maps.forEach(updateAttr.attrs, function (attr) {
					Dom.setAttrNS(reconstructedNode, attr.ns, attr.name, attr.oldValue);
				});
			}
		}
		return reconstructedNode;
	}

	function generateChanges(containerPath, container, changes, recordTree) {
		var lastInsertContent = null;
		var lastInsertNode = null;
		recordTree.forEach(function (record) {
			var type = record.type;
			if (COMPOUND_DELETE === type) {
				lastInsertNode = null;
				var path = containerPath.concat(delPath(container, record));
				record.records.forEach(function (record) {
					generateChanges(path, record.node, changes, record.contained);
				});
				changes.push(makeDeleteChange(path, record.records.map(reconstructNodeFromDelRecord)));
			} else if (INSERT === type) {
				var node = record.node;
				var path = containerPath.concat(pathBeforeNode(container, node));
				if (lastInsertNode && lastInsertNode === node.previousSibling) {
					lastInsertContent.push(Dom.clone(node));
				} else {
					lastInsertContent = [Dom.clone(node)];
					changes.push(makeInsertChange(path, lastInsertContent));
				}
				lastInsertNode = node;
			} else if (UPDATE_ATTR === type) {
				lastInsertNode = null;
				var node = record.node;
				var path = containerPath.concat(pathBeforeNode(container, node));
				changes.push(makeUpdateAttrChange(path, node, record.attrs));
			} else if (UPDATE_TEXT === type) {
				lastInsertNode = null;
				var node = record.node;
				var path = containerPath.concat(pathBeforeNode(container, node));
				changes.push(makeDeleteChange(path, [document.createTextNode(record.oldValue)]));
				changes.push(makeInsertChange(path, [Dom.clone(node)]));
			} else {
				// NB: only COMPOUND_DELETEs should occur in a recordTree,
				// DELETEs should not except as part of a COMPOUND_DELETE.
				Assert.assertError();
			}
		});
	}

	function changesFromMutationRecords(container, records) {
		var updateAttr = {};
		var updateText = {};
		var moves = [];
		records.forEach(function (record) {
			var target = record.target;
			var oldValue = record.oldValue;
			var type = record.type;
			if ('attributes' === type) {
				var name = record.attributeName;
				var ns = record.attributeNamespace;
				var id = Dom.ensureExpandoId(target);
				var updateAttrRecord = updateAttr[id] = updateAttr[id] || makeUpdateAttr(target, {});
				var attrs = updateAttrRecord.attrs;
				var attr = {oldValue: oldValue, name: name, ns: ns};
				var key = name + ' ' + ns;
				attrs[key] = attrs[key] || attr;
			} else if ('characterData' === type) {
				var id = Dom.ensureExpandoId(target);
				updateText[id] = updateText[id] || makeUpdateText(target, oldValue);
			} else if ('childList' === type) {
				var prevSibling = record.previousSibling;
				Arrays.coerce(record.removedNodes).forEach(function (node) {
					moves.push(makeDelete(node, target, prevSibling));
				});
				Arrays.coerce(record.addedNodes).forEach(function (node) {
					moves.push(makeInsert(node));
				});
			} else {
				Assert.assertError();
			}
		});
		var recordTree = makeRecordTree(container, moves, updateAttr, updateText);
		var changes = [];
		var rootPath = [];
		generateChanges(rootPath, container, changes, recordTree);
		return changes;
	}

	function changesFromSnapshots(before, after) {
		var path = [];
		stepDownPath(path, after.nodeName, 0);
		var changes = [];
		// NB: We don't clone the children because a snapshot is
		// already a copy of the actual content and is supposed to
		// be immutable.
		changes.push(makeDeleteChange(path, Dom.children(before)));
		changes.push(makeInsertChange(path, Dom.children(after)));
		return changes;
	}

	function ChangeObserverUsingMutationObserver() {
		var observedElem = null;
		var pushedRecords = [];
		var observer = new MutationObserver(function (records) {
			pushedRecords = pushedRecords.concat(records);
		});

		function observeAll(elem) {
			var observeAllFlags = {
				'childList': true,
				'attributes': true,
				'characterData': true,
				'subtree': true,
				'attributeOldValue': true,
				'characterDataOldValue': true
			};
			observer.observe(elem, observeAllFlags);
			observedElem = elem;
		}

		function takeChanges() {
			var records =  pushedRecords.concat(observer.takeRecords());
			pushedRecords.length = 0;
			return changesFromMutationRecords(observedElem, records);
		}

		function disconnect() {
 			observedElem = null;
			pushedRecords.length = 0;
			observer.disconnect();
			observer = null;
		}

		return {
			observeAll: observeAll,
			takeChanges: takeChanges,
			discardChanges: takeChanges,
			disconnect: disconnect
		};
	}

	function ChangeObserverUsingSnapshots() {
		var observedElem = null;
		var beforeSnapshot = null;

		function observeAll(elem) {
			observedElem = elem;
			beforeSnapshot = Dom.clone(elem);
		}

		function takeChanges() {
			if (Dom.isEqualNode(beforeSnapshot, observedElem)) {
				return [];
			}
			var before = beforeSnapshot;
			var after = Dom.clone(observedElem);
			beforeSnapshot = after;
			return changesFromSnapshots(before, after);
		}

		// TODO instead of discarding the snapshot and making a new one,
		// we could accept the changes that were generated instead and
		// apply them to the snapshot, which would be faster for big
		// documents.
		function discardChanges() {
			beforeSnapshot = Dom.clone(observedElem);
		}

		function disconnect() {
			observedElem = null;
			beforeSnapshot = null;
		}

		return {
			observeAll: observeAll,
			takeChanges: takeChanges,
			discardChanges: discardChanges,
			disconnect: disconnect
		};
	}

	function applyChange(container, change, range, ranges, textNodes) {
		var type = change.type;
		if ('update-attr' === type) {
			var boundary = boundaryFromPath(container, change.path);
			var node = Boundaries.nodeAfter(boundary);
			change.attrs.forEach(function (attr) {
				Dom.setAttrNS(node, attr.ns, attr.name, attr.newValue);
			});
		} else if ('update-range' === type) {
			var newRange = change.newRange;
			if (range && newRange) {
				var startBoundary = boundaryFromPath(container, newRange.start);
				var endBoundary = boundaryFromPath(container, newRange.end);
				Dom.setRangeFromBoundaries(range, startBoundary, endBoundary);
			}
		} else if ('insert' === type) {
			var boundary = boundaryFromPath(container, change.path);
			change.content.forEach(function (node) {
				var insertNode = Dom.clone(node);
				if (Dom.isTextNode(insertNode)) {
					textNodes.push(insertNode);
				}
				boundary = Dom.insertNodeAtBoundary(insertNode, boundary, true, ranges);
			});
		} else if ('delete' === type) {
			var boundary = boundaryFromPath(container, change.path);
			boundary = Dom.splitBoundary(boundary, ranges);
			var node = Dom.nodeAtBoundary(boundary);
			var parent = node.parentNode;
			change.content.forEach(function (removedNode) {
				var next;
				if (Dom.isTextNode(removedNode)) {
					var removedLen = Dom.nodeLength(removedNode);
					while (removedLen) {
						next = node.nextSibling;
						Assert.assertEqual(node.nodeName, removedNode.nodeName);
						var len = Dom.nodeLength(node);
						if (removedLen >= len) {
							Dom.removePreservingRanges(node, ranges);
							removedLen -= len;
						} else {
							boundary = Dom.splitBoundary([node, removedLen], ranges);
							var nodeBeforeSplit = Boundaries.nodeBefore(boundary);
							var nodeAfterSplit = Boundaries.nodeAfter(boundary);
							Dom.removePreservingRanges(nodeBeforeSplit, ranges);
							removedLen = 0;
							textNodes.push(nodeAfterSplit);
						}
						node = next;
					}
				} else {
					next = node.nextSibling;
					Assert.assertEqual(node.nodeName, removedNode.nodeName);
					Dom.removePreservingRanges(node, ranges);
					node = next;
				}
			});
		} else {
			Assert.assertError();
		}
	}

	function applyChanges(container, changes, ranges) {
		var textNodes = [];
		changes.forEach(function (change) {
			applyChange(container, change, null, ranges, textNodes);
		});
		textNodes.forEach(function (node) {
			Dom.joinTextNode(node, ranges);
		});
	}

	function applyChangeSet(container, changeSet, range, ranges) {
		applyChanges(container, changeSet.changes, ranges);
		if (range && changeSet.selection) {
			applyChange(container, changeSet.selection, range, ranges, []);
		}
	}

	function inverseChange(change) {
		var type = change.type;
		var inverse;
		if ('update-attr' === type) {
			inverse = Maps.merge(change, {
				attrs: change.attrs.map(function (attr) {
					return Maps.merge(attr, {oldValue: attr.newValue, newValue: attr.oldValue});
				})
			});
		} else if ('update-range' === type) {
			inverse = Maps.merge(change, {
				oldRange: change.newRange,
				newRange: change.oldRange
			});
		} else if ('insert' === type) {
			inverse = Maps.merge(change, {type: 'delete'});
		} else if ('delete' === type) {
			inverse = Maps.merge(change, {type: 'insert'});
		} else {
			Assert.assertError();
		}
		return inverse;
	}

	function inverseChangeSet(changeSet) {
		var changes = changeSet.changes.slice(0).reverse().map(inverseChange);
		return makeChangeSet(changeSet.meta, changes, inverseChange(changeSet.selection));
	}

	function collectChanges(context, frame) {
		var collectedChanges = [];
		frame.records.forEach(function (record) {
			var changes;
			var nestedFrame = record.frame;
			if (nestedFrame) {
				changes = collectChanges(context, nestedFrame);
			} else {
				changes = record.changes;
			}
			collectedChanges = collectedChanges.concat(changes);
		});
		return collectedChanges;
	}

	function changeSetFromFrameHavingChanges(context, frame, changes) {
		var rangeUpdateChange = makeRangeUpdateChange(frame.oldRange, frame.newRange);
		return makeChangeSet(frame.opts.meta, changes, rangeUpdateChange);
	}

	/**
	 * Given a frame, creates a changeSet from it.
	 *
	 * @param context {Undo}
	 * @param frame {Frame}
	 * @return {ChangeSet}
	 */
	function changeSetFromFrame(context, frame) {
		var changes = collectChanges(context, frame);
		return changeSetFromFrameHavingChanges(context, frame, changes);
	}

	function partitionedChangeSetsFromFrame(context, frame) {
		var changeSets = [];
		frame.records.forEach(function (record) {
			var changeSet;
			var nestedFrame = record.frame;
			if (nestedFrame) {
				var changes = collectChanges(context, nestedFrame);
				changeSet = changeSetFromFrameHavingChanges(context, nestedFrame, changes);
			} else {
				changeSet = changeSetFromFrameHavingChanges(context, frame, record.changes);
			}
			changeSets.push(changeSet);
		});
		return changeSets;
	}

	function combineChanges(oldChangeSet, newChangeSet, opts) {
		var oldChanges = oldChangeSet.changes;
		var newChanges = newChangeSet.changes;
		var oldType = oldChangeSet.meta && oldChangeSet.meta.type;
		var newType = newChangeSet.meta && newChangeSet.meta.type;
		// TODO combine enter as the first character of a sequence of
		// text inserts (currently will return null below because we
		// only handle text boundaries).
		if (!(('typing' === oldType || 'enter' === oldType)
		      && 'typing' === newType)) {
			return null;
		}
		var oldChange = oldChanges[0];
		var newChange = newChanges[0];
		var oldPath = oldChange.path;
		var newPath = newChange.path;
		var oldStep = Arrays.last(oldPath);
		var newStep = Arrays.last(newPath);
		// Because the text inserts may have started at a node boundary
		// but we expect text steps below, we'll just pretend they
		// started at the start of a text node.
		if (oldStep && '#text' !== oldStep[1]) {
			oldStep = ['#text', 0];
			oldPath = oldPath.concat([oldStep]);
		}
		if (oldChange.type !== 'insert'
		    || oldChange.type !== newChange.type
		    || oldStep[1] !== '#text'
		    || oldStep[1] !== newStep[1]
		    || 1 !== oldChange.content.length
		    || 1 !== newChange.content.length
		    || !Dom.isTextNode(oldChange.content[0])
		    || !Dom.isTextNode(newChange.content[0])
		    || opts.maxCombineChars <= Dom.nodeLength(oldChange.content[0])
		    || oldStep[0] + Dom.nodeLength(oldChange.content[0]) !== newStep[0]
		    || !pathEquals(oldPath.slice(0, oldPath.length - 1),
		                   newPath.slice(0, newPath.length - 1))) {
			return null;
		}
		var combinedNode = Dom.clone(oldChange.content[0]);
		combinedNode.insertData(Dom.nodeLength(combinedNode), newChange.content[0].data);
		var insertChange = makeInsertChange(oldPath, [combinedNode])
		var oldRange = oldChangeSet.selection.oldRange;
		var newRange = newChangeSet.selection.newRange
		var rangeUpdateChange = makeRangeUpdateChange(oldRange, newRange);
		return makeChangeSet(oldChangeSet.meta, [insertChange], rangeUpdateChange);
	}

	/**
	 * Sets the interrupted flag in the given undo context.
	 *
	 * The interrupted flag specifies that the next change should not be
	 * combined with the last change.
	 *
	 * @param context {Undo}
	 * @return {void}
	 */
	function interruptTyping(context) {
		context.interrupted = true;
	}

	/**
	 * Generates changeSets from the records in the current frame in the
	 * given context, empties the frame's records, and adds the
	 * changeSets to the history.
	 *
	 * The current frame should have the partitionRecords option set to
	 * true and must be a top-level frame (not a nested frame).
	 *
	 * If the current history index is not at the end of the current
	 * history, for example due to an undo, all changes after the
	 * current index will be dropped.
	 *
	 * @param context {Undo}
	 * @return {void}
	 */
	function advanceHistory(context) {
		Assert.assertFalse(!!context.stack.length);
		var history = context.history;
		var historyIndex = context.historyIndex;
		var frame = context.frame;
		takeRecords(context, frame);
		var newChangeSets = partitionedChangeSetsFromFrame(context, frame);
		if (!newChangeSets.length) {
			return;
		}
		history.length = historyIndex;
		var lastChangeSet = Arrays.last(history);
		if (1 === newChangeSets.length && lastChangeSet && !context.interrupted) {
			var combinedChangeSet = combineChanges(lastChangeSet, newChangeSets[0], context.opts);
			if (combinedChangeSet) {
				history.pop();
				newChangeSets = [combinedChangeSet];
			}
		}
		context.interrupted = false;
		history = history.concat(newChangeSets);
		var maxHistory = context.opts.maxHistory;
		if (history.length > maxHistory) {
			history = history.slice(history.length - maxHistory, history.length);
		}
		frame.records = [];
		context.history = history;
		context.historyIndex = history.length;
	}

	/**
	 * Undoes the last changeSet in the history and decreases the
	 * history index.
	 *
	 * @param context {Undo}
	 * @param range {Range} will be set to the recorded range before the
	 *        changes in the changeSet occurred.
	 * @param ranges {Array.<Range>} will be preserved.
	 * @return {void}
	 */
	function undo(context, range, ranges) {
		advanceHistory(context);
		var history = context.history;
		var historyIndex = context.historyIndex;
		if (!historyIndex) {
			return;
		}
		historyIndex -= 1;
		var changeSet = history[historyIndex];
		var undoChangeSet = inverseChangeSet(changeSet);
		captureOffTheRecord(context, {meta: {type: 'undo'}}, function () {
			applyChangeSet(context.elem, undoChangeSet, range, ranges);
		});
		context.historyIndex = historyIndex;
	}

	/**
	 * Redoes a previously undone changeSet in the history and
	 * increments the history index.
	 *
	 * @param context {Undo}
	 * @param range {Range} will be set to the recorded range after the
	 *        changes in the changeSet occurred.
	 * @param ranges {Array.<Range>} will be preserved.
	 * @return {void}
	 */
	function redo(context, range, ranges) {
		advanceHistory(context);
		var history = context.history;
		var historyIndex = context.historyIndex;
		if (historyIndex === history.length) {
			return;
		}
		var changeSet = history[historyIndex];
		historyIndex += 1;
		captureOffTheRecord(context, {meta: {type: 'redo'}}, function () {
			applyChangeSet(context.elem, changeSet, range, ranges);
		});
		context.historyIndex = historyIndex;
	}

	/**
	 * Functions for undo support.
	 */
	var exports = {
		Context: Context,
		enter: enter,
		close: close,
		leave: leave,
		capture: capture,
		pathFromBoundary: pathFromBoundary,
		changeSetFromFrame: changeSetFromFrame,
		inverseChangeSet: inverseChangeSet,
		applyChangeSet: applyChangeSet,
		advanceHistory: advanceHistory,
		makeInsertChange: makeInsertChange,
		undo: undo,
		redo: redo
	};

	exports['Context'] = exports.Context;
	exports['enter'] = exports.enter;
	exports['leave'] = exports.leave;
	exports['capture'] = exports.capture;
	exports['pathFromBoundary'] = exports.pathFromBoundary,
	exports['changeSetFromFrame'] = exports.changeSetFromFrame;
	exports['inverseChangeSet'] = exports.inverseChangeSet;
	exports['applyChangeSet'] = exports.applyChangeSet;
	exports['advanceHistory'] = exports.advanceHistory;
	exports['makeInsertChange'] = exports.makeInsertChange;
	exports['undo'] = exports.undo;
	exports['redo'] = exports.redo;

	return exports;
});