/**
 * Test setup: define vscode.ViewColumn BEFORE any module that does
 * `import * as vscode from "vscode"`.
 *
 * Why: tsc compiles that import to `__importStar(require("vscode"))`, which
 * only creates live getters for keys that exist on the stub AT REQUIRE TIME.
 * Setting `vscodeStub.ViewColumn` later (in the test file body) is too late —
 * the star-import object never gets a `ViewColumn` property, so
 * `vscode.ViewColumn.Beside` throws inside the module under test.
 *
 * Import this module after "../../services/test/vscode-stub" but before any
 * module under test that touches vscode.ViewColumn.
 */
import { vscodeStub } from "../../services/test/vscode-stub";

(vscodeStub as Record<string, unknown>).ViewColumn = { Active: 1, Beside: 2 };
