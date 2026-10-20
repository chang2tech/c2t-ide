/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// IDE-CODE: Agent system pressure — Cursor parity (feature `glass-system-pressure-commands`).
//
// Binary evidence (Cursor 3.25.9, reference/cursor-3.25.9): workbench.glass.main.js
// @47480670 — the `cursorProclist` channel client:
//
//   constructor(t){this.channel=t.getChannel("cursorProclist"),
//     this.onAgentMemoryPressureReport=this.channel.listen("onAgentMemoryPressureReport")}
//   async applyConfig(t){return this.channel.call("applyConfig",t)}
//   async killAgentProcessTree(t,e){return this.channel.call("killAgentProcessTree",{pid:t,name:e})}
//
// Registered under the service id "cursorProclistService" (Qn("cursorProclistService"),
// @44592100). Same layer as Cursor: workbench core, backed by the shared process.

import { Event } from '../../../../base/common/event.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { ISharedProcessService } from '../../../../platform/ipc/electron-browser/services.js';
import { IChannel } from '../../../../base/parts/ipc/common/ipc.js';
import {
	AGENT_MEMORY_PRESSURE_REPORT_EVENT,
	APPLY_MONITOR_CONFIG_METHOD,
	GET_PROCESS_TREE_SNAPSHOT_METHOD,
	IAgentMemoryPressureReport,
	IAgentProclistApplyConfig,
	KILL_AGENT_PROCESS_TREE_METHOD,
	PROCLIST_IPC_CHANNEL,
	PROCLIST_SERVICE_ID,
} from '../common/agentSystemPressure.js';

export const IAgentSystemPressureService = createDecorator<IAgentSystemPressureService>(PROCLIST_SERVICE_ID);

export interface IAgentSystemPressureService {
	readonly _serviceBrand: undefined;

	/**
	 * Fires whenever the process monitor reports agent system pressure
	 * (binary: `onAgentMemoryPressureReport`).
	 */
	readonly onAgentMemoryPressureReport: Event<IAgentMemoryPressureReport>;

	/**
	 * Pushes monitor thresholds to the shared process (binary: `applyConfig`).
	 * The payload mirrors the binary main-side consumer: {localEnabled,
	 * subsamplePollingRateSec, agentMemoryPressureMonitor}.
	 */
	applyConfig(config: IAgentProclistApplyConfig): Promise<void>;

	/**
	 * Kills an agent process tree (binary: `killAgentProcessTree({pid, name})`).
	 * Resolves to true when the tree was killed, false otherwise.
	 */
	killAgentProcessTree(pid: number, name: string): Promise<boolean>;

	/**
	 * Reads a fresh process-tree snapshot from the monitor
	 * (binary: `getProcessTreeSnapshot`).
	 */
	getProcessTreeSnapshot(): Promise<IAgentMemoryPressureReport['processes']>;
}

export class AgentSystemPressureService implements IAgentSystemPressureService {

	declare readonly _serviceBrand: undefined;

	private readonly channel: IChannel;

	readonly onAgentMemoryPressureReport: Event<IAgentMemoryPressureReport>;

	constructor(
		@ISharedProcessService sharedProcessService: ISharedProcessService
	) {
		this.channel = sharedProcessService.getChannel(PROCLIST_IPC_CHANNEL);
		this.onAgentMemoryPressureReport =
			this.channel.listen<IAgentMemoryPressureReport>(AGENT_MEMORY_PRESSURE_REPORT_EVENT);
	}

	applyConfig(config: IAgentProclistApplyConfig): Promise<void> {
		return this.channel.call(APPLY_MONITOR_CONFIG_METHOD, config);
	}

	killAgentProcessTree(pid: number, name: string): Promise<boolean> {
		return this.channel.call<boolean>(KILL_AGENT_PROCESS_TREE_METHOD, { pid, name });
	}

	getProcessTreeSnapshot(): Promise<IAgentMemoryPressureReport['processes']> {
		return this.channel.call(GET_PROCESS_TREE_SNAPSHOT_METHOD);
	}
}
