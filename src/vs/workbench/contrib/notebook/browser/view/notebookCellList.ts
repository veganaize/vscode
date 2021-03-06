/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as DOM from 'vs/base/browser/dom';
import { IMouseWheelEvent } from 'vs/base/browser/mouseEvent';
import { IListRenderer, IListVirtualDelegate, ListError } from 'vs/base/browser/ui/list/list';
import { IListStyles, IStyleController, MouseController, IListOptions } from 'vs/base/browser/ui/list/listWidget';
import { Emitter, Event } from 'vs/base/common/event';
import { DisposableStore, IDisposable } from 'vs/base/common/lifecycle';
import { isMacintosh } from 'vs/base/common/platform';
import { ScrollEvent } from 'vs/base/common/scrollable';
import { Range } from 'vs/editor/common/core/range';
import { TrackedRangeStickiness } from 'vs/editor/common/model';
import { PrefixSumComputer } from 'vs/editor/common/viewModel/prefixSumComputer';
import { IConfigurationService } from 'vs/platform/configuration/common/configuration';
import { IContextKeyService } from 'vs/platform/contextkey/common/contextkey';
import { IKeybindingService } from 'vs/platform/keybinding/common/keybinding';
import { IListService, IWorkbenchListOptions, WorkbenchList } from 'vs/platform/list/browser/listService';
import { IThemeService } from 'vs/platform/theme/common/themeService';
import { CellRevealPosition, CellRevealType, CursorAtBoundary, getVisibleCells, ICellRange, ICellViewModel, INotebookCellList, reduceCellRanges, CellEditState } from 'vs/workbench/contrib/notebook/browser/notebookBrowser';
import { CellViewModel, NotebookViewModel } from 'vs/workbench/contrib/notebook/browser/viewModel/notebookViewModel';
import { diff, IOutput, NOTEBOOK_EDITOR_CURSOR_BOUNDARY, CellKind } from 'vs/workbench/contrib/notebook/common/notebookCommon';

export class NotebookCellList extends WorkbenchList<CellViewModel> implements IDisposable, IStyleController, INotebookCellList {
	get onWillScroll(): Event<ScrollEvent> { return this.view.onWillScroll; }

	get rowsContainer(): HTMLElement {
		return this.view.containerDomNode;
	}
	private _previousFocusedElements: CellViewModel[] = [];
	private _localDisposableStore = new DisposableStore();
	private _viewModelStore = new DisposableStore();
	private styleElement?: HTMLStyleElement;

	private readonly _onDidRemoveOutput = new Emitter<IOutput>();
	readonly onDidRemoveOutput: Event<IOutput> = this._onDidRemoveOutput.event;
	private readonly _onDidHideOutput = new Emitter<IOutput>();
	readonly onDidHideOutput: Event<IOutput> = this._onDidHideOutput.event;

	private _viewModel: NotebookViewModel | null = null;
	private _hiddenRangeIds: string[] = [];
	private hiddenRangesPrefixSum: PrefixSumComputer | null = null;

	constructor(
		private listUser: string,
		container: HTMLElement,
		delegate: IListVirtualDelegate<CellViewModel>,
		renderers: IListRenderer<CellViewModel, any>[],
		contextKeyService: IContextKeyService,
		options: IWorkbenchListOptions<CellViewModel>,
		@IListService listService: IListService,
		@IThemeService themeService: IThemeService,
		@IConfigurationService configurationService: IConfigurationService,
		@IKeybindingService keybindingService: IKeybindingService

	) {
		super(listUser, container, delegate, renderers, options, contextKeyService, listService, themeService, configurationService, keybindingService);
		this._previousFocusedElements = this.getFocusedElements();
		this._localDisposableStore.add(this.onDidChangeFocus((e) => {
			this._previousFocusedElements.forEach(element => {
				if (e.elements.indexOf(element) < 0) {
					element.onDeselect();
				}
			});
			this._previousFocusedElements = e.elements;
		}));

		const notebookEditorCursorAtBoundaryContext = NOTEBOOK_EDITOR_CURSOR_BOUNDARY.bindTo(contextKeyService);
		notebookEditorCursorAtBoundaryContext.set('none');

		let cursorSelectionListener: IDisposable | null = null;
		let textEditorAttachListener: IDisposable | null = null;

		const recomputeContext = (element: CellViewModel) => {
			switch (element.cursorAtBoundary()) {
				case CursorAtBoundary.Both:
					notebookEditorCursorAtBoundaryContext.set('both');
					break;
				case CursorAtBoundary.Top:
					notebookEditorCursorAtBoundaryContext.set('top');
					break;
				case CursorAtBoundary.Bottom:
					notebookEditorCursorAtBoundaryContext.set('bottom');
					break;
				default:
					notebookEditorCursorAtBoundaryContext.set('none');
					break;
			}
			return;
		};

		// Cursor Boundary context
		this._localDisposableStore.add(this.onDidChangeFocus((e) => {
			if (e.elements.length) {
				cursorSelectionListener?.dispose();
				textEditorAttachListener?.dispose();
				// we only validate the first focused element
				const focusedElement = e.elements[0];

				cursorSelectionListener = focusedElement.onDidChangeState((e) => {
					if (e.selectionChanged) {
						recomputeContext(focusedElement);
					}
				});

				textEditorAttachListener = focusedElement.onDidChangeEditorAttachState(() => {
					if (focusedElement.editorAttached) {
						recomputeContext(focusedElement);
					}
				});

				recomputeContext(focusedElement);
				return;
			}

			// reset context
			notebookEditorCursorAtBoundaryContext.set('none');
		}));

	}

	elementAt(position: number): ICellViewModel {
		return this.element(this.view.indexAt(position));
	}

	elementHeight(element: ICellViewModel): number {
		let index = this._getViewIndexUpperBound(element);
		if (index === undefined || index < 0 || index >= this.length) {
			this._getViewIndexUpperBound(element);
			throw new ListError(this.listUser, `Invalid index ${index}`);
		}

		return this.view.elementHeight(index);
	}

	protected createMouseController(_options: IListOptions<CellViewModel>): MouseController<CellViewModel> {
		return new NotebookMouseController(this);
	}

	detachViewModel() {
		this._viewModelStore.clear();
		this._viewModel = null;
		this.hiddenRangesPrefixSum = null;
	}

	attachViewModel(model: NotebookViewModel) {
		this._viewModel = model;
		this._viewModelStore.add(model.onDidChangeViewCells((e) => {
			const currentRanges = this._hiddenRangeIds.map(id => this._viewModel!.getTrackedRange(id)).filter(range => range !== null) as ICellRange[];
			const newVisibleViewCells: CellViewModel[] = getVisibleCells(this._viewModel!.viewCells as CellViewModel[], currentRanges);

			const oldVisibleViewCells: CellViewModel[] = [];
			const oldViewCellMapping = new Set<string>();
			for (let i = 0; i < this.length; i++) {
				oldVisibleViewCells.push(this.element(i));
				oldViewCellMapping.add(this.element(i).uri.toString());
			}

			const viewDiffs = diff<CellViewModel>(oldVisibleViewCells, newVisibleViewCells, a => {
				return oldViewCellMapping.has(a.uri.toString());
			});

			if (e.synchronous) {
				viewDiffs.reverse().forEach((diff) => {
					// remove output in the webview
					const hideOutputs: IOutput[] = [];
					const deletedOutputs: IOutput[] = [];

					for (let i = diff.start; i < diff.start + diff.deleteCount; i++) {
						const cell = this.element(i);
						if (this._viewModel!.hasCell(cell.handle)) {
							hideOutputs.push(...cell?.model.outputs);
						} else {
							deletedOutputs.push(...cell?.model.outputs);
						}
					}

					this.splice2(diff.start, diff.deleteCount, diff.toInsert);

					hideOutputs.forEach(output => this._onDidHideOutput.fire(output));
					deletedOutputs.forEach(output => this._onDidRemoveOutput.fire(output));
				});
			} else {
				DOM.scheduleAtNextAnimationFrame(() => {
					viewDiffs.reverse().forEach((diff) => {
						const hideOutputs: IOutput[] = [];
						const deletedOutputs: IOutput[] = [];

						for (let i = diff.start; i < diff.start + diff.deleteCount; i++) {
							const cell = this.element(i);
							if (this._viewModel!.hasCell(cell.handle)) {
								hideOutputs.push(...cell?.model.outputs);
							} else {
								deletedOutputs.push(...cell?.model.outputs);
							}
						}

						this.splice2(diff.start, diff.deleteCount, diff.toInsert);

						hideOutputs.forEach(output => this._onDidHideOutput.fire(output));
						deletedOutputs.forEach(output => this._onDidRemoveOutput.fire(output));
					});
				});
			}
		}));

		this._viewModelStore.add(model.onDidChangeSelection(() => {
			// convert model selections to view selections
			const viewSelections = model.selectionHandles.map(handle => {
				return model.getCellByHandle(handle);
			}).filter(cell => !!cell).map(cell => this._getViewIndexUpperBound(cell!));
			this.setFocus(viewSelections);
		}));

		const hiddenRanges = model.getHiddenRanges();
		this.setHiddenAreas(hiddenRanges, false);
		const newRanges = reduceCellRanges(hiddenRanges);
		const viewCells = model.viewCells.slice(0) as CellViewModel[];
		newRanges.reverse().forEach(range => {
			viewCells.splice(range.start, range.end - range.start + 1);
		});

		this.splice2(0, 0, viewCells);
	}

	clear() {
		super.splice(0, this.length);
	}

	setHiddenAreas(_ranges: ICellRange[], triggerViewUpdate: boolean): boolean {
		if (!this._viewModel) {
			return false;
		}

		const newRanges = reduceCellRanges(_ranges);
		// delete old tracking ranges
		const oldRanges = this._hiddenRangeIds.map(id => this._viewModel!.getTrackedRange(id)).filter(range => range !== null) as ICellRange[];
		if (newRanges.length === oldRanges.length) {
			let hasDifference = false;
			for (let i = 0; i < newRanges.length; i++) {
				if (!(newRanges[i].start === oldRanges[i].start && newRanges[i].end === oldRanges[i].end)) {
					hasDifference = true;
					break;
				}
			}

			if (!hasDifference) {
				return false;
			}
		}

		this._hiddenRangeIds.forEach(id => this._viewModel!.setTrackedRange(id, null, TrackedRangeStickiness.GrowsOnlyWhenTypingAfter));
		const hiddenAreaIds = newRanges.map(range => this._viewModel!.setTrackedRange(null, range, TrackedRangeStickiness.GrowsOnlyWhenTypingAfter)).filter(id => id !== null) as string[];

		this._hiddenRangeIds = hiddenAreaIds;

		// set hidden ranges prefix sum
		let start = 0;
		let index = 0;
		let ret: number[] = [];

		while (index < newRanges.length) {
			for (let j = start; j < newRanges[index].start - 1; j++) {
				ret.push(1);
			}

			ret.push(newRanges[index].end - newRanges[index].start + 1 + 1);
			start = newRanges[index].end + 1;
			index++;
		}

		for (let i = start; i < this._viewModel!.length; i++) {
			ret.push(1);
		}

		const values = new Uint32Array(ret.length);
		for (let i = 0; i < ret.length; i++) {
			values[i] = ret[i];
		}

		this.hiddenRangesPrefixSum = new PrefixSumComputer(values);

		if (triggerViewUpdate) {
			this.updateHiddenAreasInView(oldRanges, newRanges);
		}

		return true;
	}

	/**
	 * oldRanges and newRanges are all reduced and sorted.
	 */
	updateHiddenAreasInView(oldRanges: ICellRange[], newRanges: ICellRange[]) {
		const oldViewCellEntries: CellViewModel[] = getVisibleCells(this._viewModel!.viewCells as CellViewModel[], oldRanges);
		const oldViewCellMapping = new Set<string>();
		oldViewCellEntries.forEach(cell => {
			oldViewCellMapping.add(cell.uri.toString());
		});

		const newViewCellEntries: CellViewModel[] = getVisibleCells(this._viewModel!.viewCells as CellViewModel[], newRanges);

		const viewDiffs = diff<CellViewModel>(oldViewCellEntries, newViewCellEntries, a => {
			return oldViewCellMapping.has(a.uri.toString());
		});

		viewDiffs.reverse().forEach((diff) => {
			// remove output in the webview
			const hideOutputs: IOutput[] = [];
			const deletedOutputs: IOutput[] = [];

			for (let i = diff.start; i < diff.start + diff.deleteCount; i++) {
				const cell = this.element(i);
				if (this._viewModel!.hasCell(cell.handle)) {
					hideOutputs.push(...cell?.model.outputs);
				} else {
					deletedOutputs.push(...cell?.model.outputs);
				}
			}

			this.splice2(diff.start, diff.deleteCount, diff.toInsert);

			hideOutputs.forEach(output => this._onDidHideOutput.fire(output));
			deletedOutputs.forEach(output => this._onDidRemoveOutput.fire(output));
		});
	}

	splice2(start: number, deleteCount: number, elements: CellViewModel[] = []): void {
		// we need to convert start and delete count based on hidden ranges
		super.splice(start, deleteCount, elements);

		const selectionsLeft = [];
		this._viewModel!.selectionHandles.forEach(handle => {
			if (this._viewModel!.hasCell(handle)) {
				selectionsLeft.push(handle);
			}
		});

		if (!selectionsLeft.length && this._viewModel!.viewCells) {
			// after splice, the selected cells are deleted
			this._viewModel!.selectionHandles = [this._viewModel!.viewCells[0].handle];
		}
	}

	getViewIndex(cell: ICellViewModel) {
		const modelIndex = this._viewModel!.getCellIndex(cell);
		if (!this.hiddenRangesPrefixSum) {
			return modelIndex;
		}

		const viewIndexInfo = this.hiddenRangesPrefixSum.getIndexOf(modelIndex);

		if (viewIndexInfo.remainder !== 0) {
			return undefined;
		} else {
			return viewIndexInfo.index;
		}
	}


	private _getViewIndexUpperBound(cell: ICellViewModel) {
		const modelIndex = this._viewModel!.getCellIndex(cell);
		if (!this.hiddenRangesPrefixSum) {
			return modelIndex;
		}

		const viewIndexInfo = this.hiddenRangesPrefixSum.getIndexOf(modelIndex);

		return viewIndexInfo.index;
	}

	focusElement(cell: ICellViewModel) {
		const index = this._getViewIndexUpperBound(cell);

		if (index !== undefined) {
			this.setFocus([index]);
		}
	}

	selectElement(cell: ICellViewModel) {
		if (this._viewModel) {
			this._viewModel.selectionHandles = [cell.handle];
		}

		const index = this._getViewIndexUpperBound(cell);
		if (index !== undefined) {
			this.setSelection([index]);
			this.setFocus([index]);
		}
	}

	setFocus(indexes: number[], browserEvent?: UIEvent): void {
		if (this._viewModel) {
			this._viewModel.selectionHandles = indexes.map(index => this.element(index)).map(cell => cell.handle);
		}

		super.setFocus(indexes, browserEvent);
	}

	revealElementInView(cell: ICellViewModel) {
		const index = this._getViewIndexUpperBound(cell);

		if (index !== undefined) {
			this._revealInView(index);
		}
	}

	revealElementInCenterIfOutsideViewport(cell: ICellViewModel) {
		const index = this._getViewIndexUpperBound(cell);

		if (index !== undefined) {
			this._revealInCenterIfOutsideViewport(index);
		}
	}

	revealElementInCenter(cell: ICellViewModel) {
		const index = this._getViewIndexUpperBound(cell);

		if (index !== undefined) {
			this._revealInCenter(index);
		}
	}

	revealElementLineInView(cell: ICellViewModel, line: number): void {
		const index = this._getViewIndexUpperBound(cell);

		if (index !== undefined) {
			this._revealLineInView(index, line);
		}
	}

	revealElementLineInCenter(cell: ICellViewModel, line: number) {
		const index = this._getViewIndexUpperBound(cell);

		if (index !== undefined) {
			this._revealLineInCenter(index, line);
		}
	}

	revealElementLineInCenterIfOutsideViewport(cell: ICellViewModel, line: number) {
		const index = this._getViewIndexUpperBound(cell);

		if (index !== undefined) {
			this._revealLineInCenterIfOutsideViewport(index, line);
		}
	}

	revealElementRangeInView(cell: ICellViewModel, range: Range): void {
		const index = this._getViewIndexUpperBound(cell);

		if (index !== undefined) {
			this._revealRangeInView(index, range);
		}
	}

	revealElementRangeInCenter(cell: ICellViewModel, range: Range): void {
		const index = this._getViewIndexUpperBound(cell);

		if (index !== undefined) {
			this._revealRangeInCenter(index, range);
		}
	}

	revealElementRangeInCenterIfOutsideViewport(cell: ICellViewModel, range: Range): void {
		const index = this._getViewIndexUpperBound(cell);

		if (index !== undefined) {
			this._revealRangeInCenterIfOutsideViewport(index, range);
		}
	}

	domElementOfElement(element: ICellViewModel): HTMLElement | null {
		const index = this._getViewIndexUpperBound(element);
		if (index !== undefined) {
			return this.view.domElement(index);
		}

		return null;
	}

	focusView() {
		this.view.domNode.focus();
	}

	getAbsoluteTopOfElement(element: ICellViewModel): number {
		let index = this._getViewIndexUpperBound(element);
		if (index === undefined || index < 0 || index >= this.length) {
			this._getViewIndexUpperBound(element);
			throw new ListError(this.listUser, `Invalid index ${index}`);
		}

		return this.view.elementTop(index);
	}

	triggerScrollFromMouseWheelEvent(browserEvent: IMouseWheelEvent) {
		this.view.triggerScrollFromMouseWheelEvent(browserEvent);
	}


	updateElementHeight2(element: ICellViewModel, size: number): void {
		const index = this._getViewIndexUpperBound(element);
		if (index === undefined) {
			return;
		}

		const focused = this.getFocus();
		this.view.updateElementHeight(index, size, focused.length ? focused[0] : null);
	}

	// override
	domFocus() {
		if (document.activeElement && this.view.domNode.contains(document.activeElement)) {
			// for example, when focus goes into monaco editor, if we refocus the list view, the editor will lose focus.
			return;
		}

		if (!isMacintosh && document.activeElement && isContextMenuFocused()) {
			return;
		}

		super.domFocus();
	}

	private _revealRange(viewIndex: number, range: Range, revealType: CellRevealType, newlyCreated: boolean, alignToBottom: boolean) {
		const element = this.view.element(viewIndex);
		const scrollTop = this.view.getScrollTop();
		const wrapperBottom = scrollTop + this.view.renderHeight;
		const startLineNumber = range.startLineNumber;
		const lineOffset = element.getLineScrollTopOffset(startLineNumber);
		const elementTop = this.view.elementTop(viewIndex);
		const lineTop = elementTop + lineOffset;

		// TODO@rebornix 30 ---> line height * 1.5
		if (lineTop < scrollTop) {
			this.view.setScrollTop(lineTop - 30);
		} else if (lineTop > wrapperBottom) {
			this.view.setScrollTop(scrollTop + lineTop - wrapperBottom + 30);
		} else if (newlyCreated) {
			// newly scrolled into view
			if (alignToBottom) {
				// align to the bottom
				this.view.setScrollTop(scrollTop + lineTop - wrapperBottom + 30);
			} else {
				// align to to top
				this.view.setScrollTop(lineTop - 30);
			}
		}

		if (revealType === CellRevealType.Range) {
			element.revealRangeInCenter(range);
		}
	}

	// List items have real dynamic heights, which means after we set `scrollTop` based on the `elementTop(index)`, the element at `index` might still be removed from the view once all relayouting tasks are done.
	// For example, we scroll item 10 into the view upwards, in the first round, items 7, 8, 9, 10 are all in the viewport. Then item 7 and 8 resize themselves to be larger and finally item 10 is removed from the view.
	// To ensure that item 10 is always there, we need to scroll item 10 to the top edge of the viewport.
	private _revealRangeInternal(viewIndex: number, range: Range, revealType: CellRevealType) {
		const scrollTop = this.view.getScrollTop();
		const wrapperBottom = scrollTop + this.view.renderHeight;
		const elementTop = this.view.elementTop(viewIndex);
		const element = this.view.element(viewIndex);

		if (element.editorAttached) {
			this._revealRange(viewIndex, range, revealType, false, false);
		} else {
			const elementHeight = this.view.elementHeight(viewIndex);
			let upwards = false;

			if (elementTop + elementHeight < scrollTop) {
				// scroll downwards
				this.view.setScrollTop(elementTop);
				upwards = false;
			} else if (elementTop > wrapperBottom) {
				// scroll upwards
				this.view.setScrollTop(elementTop - this.view.renderHeight / 2);
				upwards = true;
			}

			const editorAttachedPromise = new Promise((resolve, reject) => {
				element.onDidChangeEditorAttachState(() => {
					element.editorAttached ? resolve() : reject();
				});
			});

			editorAttachedPromise.then(() => {
				this._revealRange(viewIndex, range, revealType, true, upwards);
			});
		}
	}

	private _revealLineInView(viewIndex: number, line: number) {
		this._revealRangeInternal(viewIndex, new Range(line, 1, line, 1), CellRevealType.Line);
	}

	private _revealRangeInView(viewIndex: number, range: Range): void {
		this._revealRangeInternal(viewIndex, range, CellRevealType.Range);
	}

	private _revealRangeInCenterInternal(viewIndex: number, range: Range, revealType: CellRevealType) {
		const reveal = (viewIndex: number, range: Range, revealType: CellRevealType) => {
			const element = this.view.element(viewIndex);
			let lineOffset = element.getLineScrollTopOffset(range.startLineNumber);
			let lineOffsetInView = this.view.elementTop(viewIndex) + lineOffset;
			this.view.setScrollTop(lineOffsetInView - this.view.renderHeight / 2);

			if (revealType === CellRevealType.Range) {
				element.revealRangeInCenter(range);
			}
		};

		const elementTop = this.view.elementTop(viewIndex);
		const viewItemOffset = elementTop;
		this.view.setScrollTop(viewItemOffset - this.view.renderHeight / 2);
		const element = this.view.element(viewIndex);

		if (!element.editorAttached) {
			getEditorAttachedPromise(element).then(() => reveal(viewIndex, range, revealType));
		} else {
			reveal(viewIndex, range, revealType);
		}
	}

	private _revealLineInCenter(viewIndex: number, line: number) {
		this._revealRangeInCenterInternal(viewIndex, new Range(line, 1, line, 1), CellRevealType.Line);
	}

	private _revealRangeInCenter(viewIndex: number, range: Range): void {
		this._revealRangeInCenterInternal(viewIndex, range, CellRevealType.Range);
	}

	private _revealRangeInCenterIfOutsideViewportInternal(viewIndex: number, range: Range, revealType: CellRevealType) {
		const reveal = (viewIndex: number, range: Range, revealType: CellRevealType) => {
			const element = this.view.element(viewIndex);
			let lineOffset = element.getLineScrollTopOffset(range.startLineNumber);
			let lineOffsetInView = this.view.elementTop(viewIndex) + lineOffset;
			this.view.setScrollTop(lineOffsetInView - this.view.renderHeight / 2);

			if (revealType === CellRevealType.Range) {
				element.revealRangeInCenter(range);
			}
		};

		const scrollTop = this.view.getScrollTop();
		const wrapperBottom = scrollTop + this.view.renderHeight;
		const elementTop = this.view.elementTop(viewIndex);
		const viewItemOffset = elementTop;
		const element = this.view.element(viewIndex);

		if (viewItemOffset < scrollTop || viewItemOffset > wrapperBottom) {
			// let it render
			this.view.setScrollTop(viewItemOffset - this.view.renderHeight / 2);

			// after rendering, it might be pushed down due to markdown cell dynamic height
			const elementTop = this.view.elementTop(viewIndex);
			this.view.setScrollTop(elementTop - this.view.renderHeight / 2);

			// reveal editor
			if (!element.editorAttached) {
				getEditorAttachedPromise(element).then(() => reveal(viewIndex, range, revealType));
			} else {
				// for example markdown
			}
		} else {
			if (element.editorAttached) {
				element.revealRangeInCenter(range);
			} else {
				// for example, markdown cell in preview mode
				getEditorAttachedPromise(element).then(() => reveal(viewIndex, range, revealType));
			}
		}
	}

	private _revealLineInCenterIfOutsideViewport(viewIndex: number, line: number) {
		this._revealRangeInCenterIfOutsideViewportInternal(viewIndex, new Range(line, 1, line, 1), CellRevealType.Line);
	}

	private _revealRangeInCenterIfOutsideViewport(viewIndex: number, range: Range): void {
		this._revealRangeInCenterIfOutsideViewportInternal(viewIndex, range, CellRevealType.Range);
	}

	private _revealInternal(viewIndex: number, ignoreIfInsideViewport: boolean, revealPosition: CellRevealPosition) {
		if (viewIndex >= this.view.length) {
			return;
		}

		const scrollTop = this.view.getScrollTop();
		const wrapperBottom = scrollTop + this.view.renderHeight;
		const elementTop = this.view.elementTop(viewIndex);

		if (ignoreIfInsideViewport && elementTop >= scrollTop && elementTop < wrapperBottom) {
			// inside the viewport
			return;
		}

		// first render
		const viewItemOffset = revealPosition === CellRevealPosition.Top ? elementTop : (elementTop - this.view.renderHeight / 2);
		this.view.setScrollTop(viewItemOffset);

		// second scroll as markdown cell is dynamic
		const newElementTop = this.view.elementTop(viewIndex);
		const newViewItemOffset = revealPosition === CellRevealPosition.Top ? newElementTop : (newElementTop - this.view.renderHeight / 2);
		this.view.setScrollTop(newViewItemOffset);
	}

	private _revealInView(viewIndex: number) {
		this._revealInternal(viewIndex, true, CellRevealPosition.Top);
	}

	private _revealInCenter(viewIndex: number) {
		this._revealInternal(viewIndex, false, CellRevealPosition.Center);
	}

	private _revealInCenterIfOutsideViewport(viewIndex: number) {
		this._revealInternal(viewIndex, true, CellRevealPosition.Center);
	}

	setCellSelection(cell: ICellViewModel, range: Range) {
		const element = cell as CellViewModel;
		if (element.editorAttached) {
			element.setSelection(range);
		} else {
			getEditorAttachedPromise(element).then(() => { element.setSelection(range); });
		}
	}


	style(styles: IListStyles) {
		const selectorSuffix = this.view.domId;
		if (!this.styleElement) {
			this.styleElement = DOM.createStyleSheet(this.view.domNode);
		}
		const suffix = selectorSuffix && `.${selectorSuffix}`;
		const content: string[] = [];

		if (styles.listBackground) {
			if (styles.listBackground.isOpaque()) {
				content.push(`.monaco-list${suffix} > div.monaco-scrollable-element > .monaco-list-rows { background: ${styles.listBackground}; }`);
			} else if (!isMacintosh) { // subpixel AA doesn't exist in macOS
				console.warn(`List with id '${selectorSuffix}' was styled with a non-opaque background color. This will break sub-pixel antialiasing.`);
			}
		}

		if (styles.listFocusBackground) {
			content.push(`.monaco-list${suffix}:focus > div.monaco-scrollable-element > .monaco-list-rows > .monaco-list-row.focused { background-color: ${styles.listFocusBackground}; }`);
			content.push(`.monaco-list${suffix}:focus > div.monaco-scrollable-element > .monaco-list-rows > .monaco-list-row.focused:hover { background-color: ${styles.listFocusBackground}; }`); // overwrite :hover style in this case!
		}

		if (styles.listFocusForeground) {
			content.push(`.monaco-list${suffix}:focus > div.monaco-scrollable-element > .monaco-list-rows > .monaco-list-row.focused { color: ${styles.listFocusForeground}; }`);
		}

		if (styles.listActiveSelectionBackground) {
			content.push(`.monaco-list${suffix}:focus > div.monaco-scrollable-element > .monaco-list-rows > .monaco-list-row.selected { background-color: ${styles.listActiveSelectionBackground}; }`);
			content.push(`.monaco-list${suffix}:focus > div.monaco-scrollable-element > .monaco-list-rows > .monaco-list-row.selected:hover { background-color: ${styles.listActiveSelectionBackground}; }`); // overwrite :hover style in this case!
		}

		if (styles.listActiveSelectionForeground) {
			content.push(`.monaco-list${suffix}:focus > div.monaco-scrollable-element > .monaco-list-rows > .monaco-list-row.selected { color: ${styles.listActiveSelectionForeground}; }`);
		}

		if (styles.listFocusAndSelectionBackground) {
			content.push(`
				.monaco-drag-image,
				.monaco-list${suffix}:focus > div.monaco-scrollable-element > .monaco-list-rows > .monaco-list-row.selected.focused { background-color: ${styles.listFocusAndSelectionBackground}; }
			`);
		}

		if (styles.listFocusAndSelectionForeground) {
			content.push(`
				.monaco-drag-image,
				.monaco-list${suffix}:focus > div.monaco-scrollable-element > .monaco-list-rows > .monaco-list-row.selected.focused { color: ${styles.listFocusAndSelectionForeground}; }
			`);
		}

		if (styles.listInactiveFocusBackground) {
			content.push(`.monaco-list${suffix} > div.monaco-scrollable-element > .monaco-list-rows > .monaco-list-row.focused { background-color:  ${styles.listInactiveFocusBackground}; }`);
			content.push(`.monaco-list${suffix} > div.monaco-scrollable-element > .monaco-list-rows > .monaco-list-row.focused:hover { background-color:  ${styles.listInactiveFocusBackground}; }`); // overwrite :hover style in this case!
		}

		if (styles.listInactiveSelectionBackground) {
			content.push(`.monaco-list${suffix} > div.monaco-scrollable-element > .monaco-list-rows > .monaco-list-row.selected { background-color:  ${styles.listInactiveSelectionBackground}; }`);
			content.push(`.monaco-list${suffix} > div.monaco-scrollable-element > .monaco-list-rows > .monaco-list-row.selected:hover { background-color:  ${styles.listInactiveSelectionBackground}; }`); // overwrite :hover style in this case!
		}

		if (styles.listInactiveSelectionForeground) {
			content.push(`.monaco-list${suffix} > div.monaco-scrollable-element > .monaco-list-rows > .monaco-list-row.selected { color: ${styles.listInactiveSelectionForeground}; }`);
		}

		if (styles.listHoverBackground) {
			content.push(`.monaco-list${suffix}:not(.drop-target) > div.monaco-scrollable-element > .monaco-list-rows > .monaco-list-row:hover:not(.selected):not(.focused) { background-color:  ${styles.listHoverBackground}; }`);
		}

		if (styles.listHoverForeground) {
			content.push(`.monaco-list${suffix} > div.monaco-scrollable-element > .monaco-list-rows > .monaco-list-row:hover:not(.selected):not(.focused) { color:  ${styles.listHoverForeground}; }`);
		}

		if (styles.listSelectionOutline) {
			content.push(`.monaco-list${suffix} > div.monaco-scrollable-element > .monaco-list-rows > .monaco-list-row.selected { outline: 1px dotted ${styles.listSelectionOutline}; outline-offset: -1px; }`);
		}

		if (styles.listFocusOutline) {
			content.push(`
				.monaco-drag-image,
				.monaco-list${suffix}:focus > div.monaco-scrollable-element > .monaco-list-rows > .monaco-list-row.focused { outline: 1px solid ${styles.listFocusOutline}; outline-offset: -1px; }
			`);
		}

		if (styles.listInactiveFocusOutline) {
			content.push(`.monaco-list${suffix} > div.monaco-scrollable-element > .monaco-list-rows > .monaco-list-row.focused { outline: 1px dotted ${styles.listInactiveFocusOutline}; outline-offset: -1px; }`);
		}

		if (styles.listHoverOutline) {
			content.push(`.monaco-list${suffix} > div.monaco-scrollable-element > .monaco-list-rows > .monaco-list-row:hover { outline: 1px dashed ${styles.listHoverOutline}; outline-offset: -1px; }`);
		}

		if (styles.listDropBackground) {
			content.push(`
				.monaco-list${suffix}.drop-target,
				.monaco-list${suffix} > div.monaco-scrollable-element > .monaco-list-rows.drop-target,
				.monaco-list${suffix} > div.monaco-scrollable-element > .monaco-list-row.drop-target { background-color: ${styles.listDropBackground} !important; color: inherit !important; }
			`);
		}

		if (styles.listFilterWidgetBackground) {
			content.push(`.monaco-list-type-filter { background-color: ${styles.listFilterWidgetBackground} }`);
		}

		if (styles.listFilterWidgetOutline) {
			content.push(`.monaco-list-type-filter { border: 1px solid ${styles.listFilterWidgetOutline}; }`);
		}

		if (styles.listFilterWidgetNoMatchesOutline) {
			content.push(`.monaco-list-type-filter.no-matches { border: 1px solid ${styles.listFilterWidgetNoMatchesOutline}; }`);
		}

		if (styles.listMatchesShadow) {
			content.push(`.monaco-list-type-filter { box-shadow: 1px 1px 1px ${styles.listMatchesShadow}; }`);
		}

		const newStyles = content.join('\n');
		if (newStyles !== this.styleElement.innerHTML) {
			this.styleElement.innerHTML = newStyles;
		}
	}

	dispose() {
		this._localDisposableStore.dispose();
		super.dispose();
	}
}

function getEditorAttachedPromise(element: CellViewModel) {
	return new Promise((resolve, reject) => {
		Event.once(element.onDidChangeEditorAttachState)(() => element.editorAttached ? resolve() : reject());
	});
}

function isContextMenuFocused() {
	return !!DOM.findParentWithClass(<HTMLElement>document.activeElement, 'context-view');
}


class NotebookMouseController extends MouseController<CellViewModel> {
	protected onDoubleClick(): void {
		const focus = this.list.getFocusedElements()[0];
		if (focus && focus.cellKind === CellKind.Markdown) {
			focus.editState = CellEditState.Editing;
		}
	}
}
