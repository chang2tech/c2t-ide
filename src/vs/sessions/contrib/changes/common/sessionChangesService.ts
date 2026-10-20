/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IObservable } from '../../../../base/common/observable.js';
import { URI } from '../../../../base/common/uri.js';
import { IMultiDiffEditorOptions } from '../../../../editor/common/multiDiffEditor.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { IEditorGroup } from '../../../../workbench/services/editor/common/editorGroupsService.js';
import { PreferredGroup } from '../../../../workbench/services/editor/common/editorService.js';
import { ISessionChangeset } from '../../../services/sessions/common/session.js';

export const ISessionChangesService = createDecorator<ISessionChangesService>('sessionChangesService');

/** Options for opening a session Changes editor with an optional changeset selection. */
export interface ISessionChangesEditorOptions extends IMultiDiffEditorOptions {
	readonly changesetSelection?:
	| { readonly kind: 'id'; readonly id: string | undefined }
	| { readonly kind: 'transient'; readonly changeset: ISessionChangeset };
}

/**
 * Verbatim binary `workbench.editor.reviewchanges` input props (Cursor
 * `workbench-open-changes-tab`; audit-fix-queue "Deepening closed"):
 * {composerId, parentComposerId, initialMode, fromBugbot, scrollToFile,
 * scrollToLine, scrollToReviewFile, fromBackgroundAgent, gitMode, gitModeLabel}.
 * Cursor's reviewChangesEditor.js renderer internals are UNKNOWN; these props
 * are the observed identity surface only.
 */
export interface IReviewChangesProps {
	readonly composerId?: string;
	readonly parentComposerId?: string;
	readonly initialMode?: string;
	readonly fromBugbot?: boolean;
	readonly scrollToFile?: string;
	readonly scrollToLine?: number;
	readonly scrollToReviewFile?: string;
	readonly fromBackgroundAgent?: boolean;
	readonly gitMode?: boolean;
	readonly gitModeLabel?: string;
}

/** Owns the identity and presentation state of a session's Changes editor. */
export interface ISessionChangesService {
	readonly _serviceBrand: undefined;
	readonly activeSessionUncommittedChangesCountObs: IObservable<number | undefined>;

	/** Builds the multi-diff source URI that identifies a session's Changes editor. */
	getChangesEditorResource(sessionResource: URI): URI;

	/** Returns the session identified by a Changes editor resource. */
	getSessionResource(editorResource: URI): URI | undefined;

	/** Opens the Changes editor for a session. */
	openChangesEditor(sessionResource: URI, options?: ISessionChangesEditorOptions, group?: PreferredGroup): Promise<IEditorGroup | undefined>;

	/**
	 * Opens the Review Changes editor for a session (Cursor
	 * `workbench.editor.reviewchanges` analog; identity via
	 * `reviewChangesTabIdentity.js`). [fork-local] rendered by the session
	 * Changes editor infrastructure (which already carries changeset-review
	 * affordances); Cursor's reviewChangesEditor.js internals are UNKNOWN and
	 * are NOT reimplemented.
	 */
	openReviewChangesEditor(sessionResource: URI, reviewProps: IReviewChangesProps, options?: ISessionChangesEditorOptions, group?: PreferredGroup): Promise<IEditorGroup | undefined>;
}
