/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// IDE-CODE: "heavy-load" Manage Processes modal — Cursor parity
// (feature `glass-system-pressure-commands`).
//
// Binary evidence (Cursor 3.25.9, reference/cursor-3.25.9): the dialog component
// `glass-heavy-load-dialog.react.js` in workbench.glass.main.js (@30157000-@30163100):
//   - columns [{column:"process",label:"Process"},{column:"memory",label:"RAM"},
//             {column:"cpu",label:"CPU"}]
//   - default sort memory/desc; header click = toggle on active column, "process"
//     resets to asc, other columns reset to desc (see nextProcessSort)
//   - row aria-label = display name (de(): agentName - name), row tooltip title =
//     command line (gwC(): name + args)
//   - RAM cell = fwC(memoryMB), CPU cell = Math.round(cpuUtilPct) + "%"
//   - killed pids are filtered out of the table (Set `u`)
//   - selection = clicked pid, falling back to the first row (pe.find(pid===l) ?? pe[0])
//   - "Kill Process" footer button (tone danger) is disabled with no selection;
//     on kill success the modal closes when it was the last row, otherwise the pid
//     joins the killed set and the selection clears
//
// HONEST-DIVERGENCE: Cursor renders this with its glass React modal stack
// (openModal("heavy-load", props)). This fork's workbench renders DOM, so the same
// component semantics are implemented as a DOM overlay; styling approximates the
// dialog (title/subtitle/table/footer) without the glass CSS-in-JS classes.

import { Disposable, IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { getActiveDocument } from '../../../../base/browser/dom.js';
import {
	AgentProcessSortKey,
	filterKilledProcesses,
	formatProcessMemoryMB,
	IAgentMemoryPressureReport,
	IAgentProcessInfo,
	KILL_PROCESS_BUTTON_LABEL,
	MANAGE_PROCESSES_MODAL_SUBTITLE,
	MANAGE_PROCESSES_MODAL_TITLE,
	nextProcessSort,
	processCommandLine,
	resolveProcessDisplayName,
	sortAgentProcesses,
	SortDirection,
} from '../common/agentSystemPressure.js';

export interface IHeavyLoadModalOptions {
	readonly onKill: (pid: number, name: string) => Promise<boolean>;
	/** Emitted after a successful kill (binary: notify "Process Killed"). */
	readonly onProcessKilled: () => void;
	/** Resolves an agent id to its display name for the "agent - process" label. */
	readonly resolveAgentName?: (agentId: string) => string | undefined;
	readonly onClose?: () => void;
}

const COLUMNS: readonly { readonly key: AgentProcessSortKey; readonly label: string }[] = [
	{ key: 'process', label: 'Process' },
	{ key: 'memory', label: 'RAM' },
	{ key: 'cpu', label: 'CPU' },
];

export class HeavyLoadModal extends Disposable {

	private readonly root: HTMLElement;
	private readonly tableBody: HTMLElement;
	private readonly killButton: HTMLButtonElement;
	private readonly disposables: IDisposable[] = [];

	private report: IAgentMemoryPressureReport;
	private sortKey: AgentProcessSortKey = 'memory';
	private sortDirection: SortDirection = 'desc';
	private killedPids = new Set<number>();
	private selectedPid: number | undefined = undefined;
	private openFlag = false;

	constructor(
		report: IAgentMemoryPressureReport,
		private readonly options: IHeavyLoadModalOptions
	) {
		super();
		this.report = report;

		const doc = getActiveDocument();
		this.root = doc.createElement('div');
		this.root.className = 'agent-system-pressure-modal-backdrop';
		this.root.style.cssText = [
			'position:fixed', 'inset:0', 'z-index:2600',
			'background:rgba(0,0,0,0.4)',
			'display:flex', 'align-items:center', 'justify-content:center',
		].join(';');

		const dialog = doc.createElement('div');
		dialog.className = 'agent-system-pressure-modal';
		dialog.setAttribute('role', 'dialog');
		dialog.setAttribute('aria-modal', 'true');
		dialog.setAttribute('aria-label', MANAGE_PROCESSES_MODAL_TITLE);
		dialog.style.cssText = [
			'min-width:560px', 'max-width:720px', 'max-height:80vh',
			'overflow:auto', 'border-radius:8px', 'padding:20px',
			'background:var(--vscode-editor-background)',
			'color:var(--vscode-editor-foreground)',
			'box-shadow:0 8px 32px rgba(0,0,0,0.35)',
			'font-family:var(--vscode-font-family)',
		].join(';');

		const title = doc.createElement('h2');
		title.textContent = MANAGE_PROCESSES_MODAL_TITLE;
		title.style.cssText = 'margin:0 0 6px 0;font-size:15px;font-weight:600;';
		dialog.appendChild(title);

		const subtitle = doc.createElement('p');
		subtitle.textContent = MANAGE_PROCESSES_MODAL_SUBTITLE;
		subtitle.style.cssText = 'margin:0 0 14px 0;font-size:12px;opacity:0.75;';
		dialog.appendChild(subtitle);

		const table = doc.createElement('table');
		table.style.cssText = 'width:100%;border-collapse:collapse;font-size:12px;';
		const thead = doc.createElement('thead');
		const headRow = doc.createElement('tr');
		for (const column of COLUMNS) {
			const th = doc.createElement('th');
			th.textContent = column.label;
			th.dataset['sortKey'] = column.key;
			th.setAttribute('aria-sort', 'none');
			th.style.cssText = 'text-align:left;padding:6px 8px;cursor:pointer;border-bottom:1px solid var(--vscode-panel-border, rgba(127,127,127,0.3));user-select:none;';
			th.addEventListener('click', () => {
				const next = nextProcessSort({ key: this.sortKey, direction: this.sortDirection }, column.key);
				this.sortKey = next.key;
				this.sortDirection = next.direction;
				this.render();
			});
			headRow.appendChild(th);
		}
		thead.appendChild(headRow);
		table.appendChild(thead);
		this.tableBody = doc.createElement('tbody');
		table.appendChild(this.tableBody);
		dialog.appendChild(table);

		const footer = doc.createElement('div');
		footer.style.cssText = 'display:flex;justify-content:flex-end;margin-top:16px;';
		this.killButton = doc.createElement('button');
		this.killButton.textContent = KILL_PROCESS_BUTTON_LABEL;
		this.killButton.style.cssText = [
			'padding:8px 16px', 'border:none', 'border-radius:4px', 'cursor:pointer',
			'background:var(--vscode-inputValidation-errorBackground, #b42318)',
			'color:#fff', 'font-size:13px',
		].join(';');
		this.killButton.addEventListener('click', () => { void this.killSelected(); });
		footer.appendChild(this.killButton);
		dialog.appendChild(footer);

		this.root.appendChild(dialog);
		this.root.addEventListener('click', (e) => {
			if (e.target === this.root) {
				this.close();
			}
		});
		const onKeyDown = (e: KeyboardEvent) => {
			if (e.key === 'Escape') {
				this.close();
			}
		};
		doc.addEventListener('keydown', onKeyDown);
		this.disposables.push(toDisposable(() => doc.removeEventListener('keydown', onKeyDown)));
		this._register(toDisposable(() => this.root.remove()));

		this.render();
	}

	get isOpen(): boolean {
		return this.openFlag;
	}

	open(): void {
		if (this.openFlag) {
			return;
		}
		this.openFlag = true;
		getActiveDocument().body.appendChild(this.root);
	}

	/** Modal props update — the binary calls updateModalProps("heavy-load", ...) on new reports. */
	update(report: IAgentMemoryPressureReport): void {
		this.report = report;
		this.render();
	}

	close(): void {
		if (!this.openFlag) {
			return;
		}
		this.openFlag = false;
		this.root.remove();
		this.options.onClose?.();
	}

	override dispose(): void {
		this.close();
		for (const d of this.disposables) {
			d.dispose();
		}
		super.dispose();
	}

	private displayNameOf(process: IAgentProcessInfo): string {
		const agentName = process.ownerAgentId ? this.options.resolveAgentName?.(process.ownerAgentId) : undefined;
		return resolveProcessDisplayName(process, agentName);
	}

	/** Visible rows: killed filtered out, sorted per current sort state (binary: pe). */
	private visibleRows(): IAgentProcessInfo[] {
		const alive = filterKilledProcesses(this.report.processes, this.killedPids);
		return sortAgentProcesses(alive, this.sortKey, this.sortDirection, p => this.displayNameOf(p));
	}

	/** Selected row: clicked pid, falling back to the first row (binary: pe.find(pid===l) ?? pe[0]). */
	private selectedRow(): IAgentProcessInfo | undefined {
		const rows = this.visibleRows();
		return rows.find(p => p.pid === this.selectedPid) ?? rows[0];
	}

	private render(): void {
		const doc = getActiveDocument();
		this.tableBody.textContent = '';
		const rows = this.visibleRows();
		for (const process of rows) {
			const tr = doc.createElement('tr');
			tr.setAttribute('aria-label', this.displayNameOf(process));
			tr.title = processCommandLine(process);
			tr.style.cssText = 'cursor:pointer;' + (this.selectedRow()?.pid === process.pid
				? 'background:var(--vscode-list-activeSelectionBackground, rgba(127,127,127,0.2));'
				: '');
			tr.addEventListener('click', () => {
				this.selectedPid = process.pid;
				this.render();
			});

			const nameCell = doc.createElement('td');
			nameCell.textContent = this.displayNameOf(process);
			nameCell.style.cssText = 'padding:6px 8px;';
			tr.appendChild(nameCell);

			const ramCell = doc.createElement('td');
			ramCell.textContent = formatProcessMemoryMB(process.memoryMB);
			ramCell.style.cssText = 'padding:6px 8px;';
			tr.appendChild(ramCell);

			const cpuCell = doc.createElement('td');
			cpuCell.textContent = `${Math.round(process.cpuUtilPct)}%`;
			cpuCell.style.cssText = 'padding:6px 8px;';
			tr.appendChild(cpuCell);

			this.tableBody.appendChild(tr);
		}
		for (const th of this.root.querySelectorAll('th')) {
			const key = (th as HTMLElement).dataset['sortKey'];
			th.setAttribute('aria-sort', key === this.sortKey ? (this.sortDirection === 'asc' ? 'ascending' : 'descending') : 'none');
		}
		// "Kill Process" is disabled with no selection (binary: disabled: w===void 0).
		this.killButton.disabled = this.selectedRow() === undefined;
		this.killButton.style.opacity = this.killButton.disabled ? '0.5' : '1';
	}

	/**
	 * Kill flow — verbatim from the binary:
	 *   if(!(!w||!await r(w.pid,w.name))){
	 *     notify "Process Killed";
	 *     if(ce.length===1){ close(); return }
	 *     killed.add(w.pid); selection = undefined }
	 */
	private async killSelected(): Promise<void> {
		const selected = this.selectedRow();
		if (!selected) {
			return;
		}
		const killed = await this.options.onKill(selected.pid, selected.name);
		if (!killed) {
			return;
		}
		this.options.onProcessKilled();
		if (this.visibleRows().length === 1) {
			this.close();
			return;
		}
		this.killedPids = new Set(this.killedPids).add(selected.pid);
		this.selectedPid = undefined;
		this.render();
	}
}
