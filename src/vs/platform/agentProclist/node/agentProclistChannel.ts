/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// IDE-CODE: `cursorProclist` IPC channel — Cursor parity (r2m-001a / r2m-001b).
//
// Verbatim transcription of the Jwe channel class (cursorProclistIpc.js in the
// Cursor 3.25.6 main bundle, @2227800):
//
//   class{constructor(e){this.service=e}
//     listen(e,t){ switch(t){ case "onAgentMemoryPressureReport":
//       return this.service.onAgentMemoryPressureReport }
//       throw new Error(`Event not found: ${t}`) }
//     async call(e,t,n){ switch(t){
//       case "applyConfig": return this.service.applyConfig(n);
//       case "createSample": return this.service.createSample();
//       case "writeSample": return this.service.writeSample(n);
//       case "readProcessMonitorData": return this.service.readProcessMonitorData();
//       case "getLiveNetworkBytesPerSec": return this.service.getLiveNetworkBytesPerSec();
//       case "killAgentProcessTree": return this.service.killAgentProcessTree(n.pid,n.name);
//       case "getProcessTreeSnapshot": return this.service.getProcessTreeSnapshot();
//       case "getCpuProcessTreeSnapshot": return this.service.getCpuProcessTreeSnapshot();
//       case "getSystemProcessList": return this.service.getSystemProcessList(n);
//       case "stashPendingUploadSamples": return this.service.stashPendingUploadSamples(n);
//       case "takePendingUploadSamples": return this.service.takePendingUploadSamples() }}}
//
// HONEST-DIVERGENCE: the sample/telemetry methods (createSample, writeSample,
// readProcessMonitorData, getLiveNetworkBytesPerSec, getCpuProcessTreeSnapshot,
// getSystemProcessList, stash/takePendingUploadSamples) belong to Cursor's
// backend reporting pipeline and are not implemented here; this channel only
// wires the pressure-monitor surface (applyConfig, killAgentProcessTree,
// getProcessTreeSnapshot, onAgentMemoryPressureReport) that the workbench
// client uses. Unknown calls throw, mirroring the binary's "not found" errors.

import { Event } from '../../../base/common/event.js';
import { IServerChannel } from '../../../base/parts/ipc/common/ipc.js';
import {
	AGENT_MEMORY_PRESSURE_REPORT_EVENT,
	APPLY_MONITOR_CONFIG_METHOD,
	GET_PROCESS_TREE_SNAPSHOT_METHOD,
	IAgentProclistApplyConfig,
	IAgentProclistService,
	KILL_AGENT_PROCESS_TREE_METHOD,
} from '../common/agentProclist.js';

export class AgentProclistChannel implements IServerChannel<string> {

	constructor(private readonly service: IAgentProclistService) { }

	listen<T>(_: string, event: string): Event<T> {
		switch (event) {
			case AGENT_MEMORY_PRESSURE_REPORT_EVENT:
				return this.service.onAgentMemoryPressureReport as Event<T>;
		}
		throw new Error(`Event not found: ${event}`);
	}

	async call<T>(_: string, command: string, arg?: unknown): Promise<T> {
		switch (command) {
			case APPLY_MONITOR_CONFIG_METHOD:
				return this.service.applyConfig(arg as IAgentProclistApplyConfig) as Promise<T>;
			case KILL_AGENT_PROCESS_TREE_METHOD: {
				const { pid, name } = arg as { pid: number; name: string };
				return this.service.killAgentProcessTree(pid, name) as Promise<T>;
			}
			case GET_PROCESS_TREE_SNAPSHOT_METHOD:
				return this.service.getProcessTreeSnapshot() as Promise<T>;
		}
		throw new Error(`Method not found: ${command}`);
	}
}
