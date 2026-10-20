/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Cursor parity: Review Changes editor (`workbench-open-changes-tab`).
 *
 * Binary evidence (audit-fix-queue "Deepening closed", workbench.glass.main.js 3.25.6):
 *   - renderer files: `reviewChangesTabIdentity.js` + `reviewChangesEditor.js`
 *   - input id: `workbench.editor.reviewchanges`
 *   - props: {composerId, parentComposerId, initialMode, fromBugbot, scrollToFile,
 *     scrollToLine, scrollToReviewFile, fromBackgroundAgent, gitMode, gitModeLabel}
 *   - serialized: {composerIdOverride, parentComposerId, options}
 *
 * [fork-local] The fork's sessions workbench renders this surface with the
 * existing SessionChangesEditor infrastructure (which already carries
 * changeset-review affordances — see changesetReviewActions.ts); Cursor's
 * reviewChangesEditor.js renderer internals are UNKNOWN and are NOT
 * reimplemented here. This input only carries Cursor's verbatim identity
 * (props + serialized shape) so the Review Changes tab is distinguishable
 * from the plain Changes editor.
 */

import { localize } from '../../../../nls.js';
import { URI } from '../../../../base/common/uri.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IEditorSerializer, IUntypedEditorInput } from '../../../../workbench/common/editor.js';
import { EditorInput } from '../../../../workbench/common/editor/editorInput.js';
import { IAgentWorkbenchLayoutService } from '../../../browser/workbench.js';
import { IReviewChangesProps } from '../common/sessionChangesService.js';
import { ISessionChangesService } from './sessionChangesService.js';
import { SessionChangesEditorInput } from './sessionChangesEditorInput.js';

/**
 * Verbatim binary serialized shape: {composerIdOverride, parentComposerId, options}.
 * `multiDiffSourceUri` is fork-local (required to rebuild the input — same
 * precedent as SessionChangesEditorSerializer's ISerializedSessionChangesEditorInput).
 */
export interface ISerializedSessionReviewChangesEditorInput {
	readonly multiDiffSourceUri: string;
	readonly composerIdOverride?: string;
	readonly parentComposerId?: string;
	readonly options?: IReviewChangesProps;
}

/**
 * Editor input for the Review Changes tab (sessions-workbench analog of
 * Cursor's binary `reviewChangesTabIdentity.js`; the verbatim binary input id
 * `workbench.editor.reviewchanges` is kept as a comment — the fork namespaces
 * its own input ids).
 */
export class SessionReviewChangesEditorInput extends SessionChangesEditorInput {

	static readonly ID = 'workbench.input.agentSessions.sessionReviewChanges';
	static readonly EDITOR_ID = 'workbench.editor.agentSessions.sessionReviewChanges';
	/** Verbatim Cursor input id (binary `workbench.editor.reviewchanges`). Kept as data for parity reference. */
	static readonly CURSOR_INPUT_ID = 'workbench.editor.reviewchanges';

	constructor(
		multiDiffSource: URI,
		/** Verbatim binary `workbench.editor.reviewchanges` props. */
		readonly reviewProps: IReviewChangesProps,
		@IInstantiationService instantiationService: IInstantiationService,
		@ISessionChangesService sessionChangesService: ISessionChangesService,
		@IAgentWorkbenchLayoutService layoutService: IAgentWorkbenchLayoutService,
	) {
		super(multiDiffSource, instantiationService, sessionChangesService, layoutService);
	}

	override get typeId(): string {
		return SessionReviewChangesEditorInput.ID;
	}

	override get editorId(): string {
		return SessionReviewChangesEditorInput.EDITOR_ID;
	}

	override getName(): string {
		// Verbatim UI string "Review Changes" (binary: 5 occurrences).
		return localize('sessionReviewChangesEditor.name', "Review Changes");
	}

	override getTitle(): string {
		return this.getName();
	}

	override matches(otherInput: EditorInput | IUntypedEditorInput): boolean {
		if (this === otherInput) {
			return true;
		}
		// A Review Changes tab is never the same tab as the plain Changes editor,
		// even for the same session (different surface, different identity).
		if (!(otherInput instanceof SessionReviewChangesEditorInput)) {
			return false;
		}
		return otherInput.multiDiffSource.toString() === this.multiDiffSource.toString()
			&& otherInput.reviewProps.composerId === this.reviewProps.composerId
			&& otherInput.reviewProps.scrollToFile === this.reviewProps.scrollToFile;
	}

	/** Verbatim binary serialized shape: {composerIdOverride, parentComposerId, options}. */
	toJSON(): ISerializedSessionReviewChangesEditorInput {
		return {
			multiDiffSourceUri: this.multiDiffSource.toString(),
			composerIdOverride: this.reviewProps.composerId,
			parentComposerId: this.reviewProps.parentComposerId,
			options: { ...this.reviewProps },
		};
	}
}

export class SessionReviewChangesEditorSerializer implements IEditorSerializer {

	canSerialize(editorInput: EditorInput): editorInput is SessionReviewChangesEditorInput {
		return editorInput instanceof SessionReviewChangesEditorInput;
	}

	serialize(editorInput: EditorInput): string | undefined {
		if (!this.canSerialize(editorInput)) {
			return undefined;
		}
		return JSON.stringify(editorInput.toJSON());
	}

	deserialize(instantiationService: IInstantiationService, serializedEditor: string): EditorInput | undefined {
		try {
			const data = JSON.parse(serializedEditor) as ISerializedSessionReviewChangesEditorInput;
			const reviewProps: IReviewChangesProps = {
				...(data.options ?? {}),
				composerId: data.composerIdOverride ?? data.options?.composerId,
				parentComposerId: data.parentComposerId ?? data.options?.parentComposerId,
			};
			return instantiationService.createInstance(SessionReviewChangesEditorInput, URI.parse(data.multiDiffSourceUri), reviewProps);
		} catch {
			return undefined;
		}
	}
}
