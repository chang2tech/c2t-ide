// IDE-CODE: Migrated from extensions/ide-agent/src/services/chime.ts (CAT-A, pure logic).
import * as childProcess from "child_process";
import * as fs from "fs";
import * as path from "path";

/**
 * Chime — plays a short sound when a chat turn completes.
 * Wires `ide.composer.shouldChimeAfterChatFinishes` /
 * `ide.composer.customChimeSoundPath` (Cursor parity).
 *
 * Playback is fire-and-forget via the platform's native audio player:
 * afplay (macOS), aplay/paplay (Linux), PowerShell SoundPlayer (Windows).
 * Never throws — a missing player or bad file path silently skips the chime.
 */

export interface ChimeOptions {
  /** Absolute path to a user-provided sound file (mp3/wav/ogg). Empty = default. */
  customPath: string;
  /** Absolute path to the bundled default chime (media/chime.wav). */
  defaultPath?: string;
}

/** Resolve which sound file to play, if any. */
export function resolveChimeFile(opts: ChimeOptions): string | undefined {
  const custom = (opts.customPath || "").trim();
  if (custom) {
    try {
      const stat = fs.statSync(custom);
      if (stat.isFile()) return custom;
    } catch {
      // Bad custom path — fall through to the default.
    }
  }
  if (opts.defaultPath) {
    try {
      const stat = fs.statSync(opts.defaultPath);
      if (stat.isFile()) return opts.defaultPath;
    } catch {
      // No bundled sound — nothing to play.
    }
  }
  return undefined;
}

/** Build the platform player command for a sound file. */
function playerCommand(file: string): { cmd: string; args: string[] } | undefined {
  switch (process.platform) {
    case "darwin":
      return { cmd: "afplay", args: [file] };
    case "win32":
      return {
        cmd: "powershell",
        args: [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `(New-Object Media.SoundPlayer '${file.replace(/'/g, "''")}').PlaySync()`,
        ],
      };
    default: {
      // Linux: prefer paplay (PulseAudio), then aplay (ALSA).
      for (const player of ["paplay", "aplay"]) {
        try {
          childProcess.execFileSync("which", [player], { stdio: "ignore" });
          return { cmd: player, args: [file] };
        } catch {
          // Not installed — try the next one.
        }
      }
      // Last resort: xdg-open style players can't be fire-and-forget safely.
      return undefined;
    }
  }
}

/**
 * Play the completion chime. Resolves when the player exits (or immediately
 * when there is nothing to play). Never rejects.
 */
export async function playChime(opts: ChimeOptions): Promise<void> {
  const file = resolveChimeFile(opts);
  if (!file) return;
  const player = playerCommand(file);
  if (!player) return;
  await new Promise<void>((resolve) => {
    try {
      const child = childProcess.spawn(player.cmd, player.args, {
        stdio: "ignore",
        detached: true,
        // Don't let a hung player keep the extension host alive.
        ...(process.platform !== "win32" ? {} : {}),
      });
      const done = () => resolve();
      child.on("error", done);
      child.on("exit", done);
      // Safety: never wait more than 10s for a chime.
      setTimeout(done, 10_000).unref?.();
      // Detach so the player doesn't hold the event loop.
      child.unref?.();
    } catch {
      resolve();
    }
  });
}

/** Default chime location inside the extension folder. */
export function defaultChimePath(extensionPath: string): string {
  return path.join(extensionPath, "media", "chime.wav");
}
