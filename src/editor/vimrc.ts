/**
 * Loads a supported subset of the user's vimrc into @replit/codemirror-vim.
 *
 * Supported: the map/noremap/unmap families (n/i/v/x variants), leader
 * substitution via `let mapleader`, and the handful of `set` options the
 * vim port actually implements. Everything else is skipped and reported.
 */
import { Vim } from "@replit/codemirror-vim";

export interface VimrcSummary {
  path: string;
  applied: number;
  skipped: string[]; // human-readable "<line>: <reason>"
}

type MapMode = "normal" | "insert" | "visual" | undefined;

const MAP_MODES: Record<string, { mode: MapMode; remap: boolean }> = {
  map: { mode: undefined, remap: true },
  noremap: { mode: undefined, remap: false },
  nmap: { mode: "normal", remap: true },
  nnoremap: { mode: "normal", remap: false },
  imap: { mode: "insert", remap: true },
  inoremap: { mode: "insert", remap: false },
  vmap: { mode: "visual", remap: true },
  vnoremap: { mode: "visual", remap: false },
  xmap: { mode: "visual", remap: true },
  xnoremap: { mode: "visual", remap: false },
};

const UNMAP_MODES: Record<string, MapMode> = {
  unmap: undefined,
  nunmap: "normal",
  iunmap: "insert",
  vunmap: "visual",
  xunmap: "visual",
};

/** Options implemented by @replit/codemirror-vim (plus aliases). */
const KNOWN_OPTIONS: Record<string, { canonical: string; type: "number" | "boolean" | "string" }> = {
  textwidth: { canonical: "textwidth", type: "number" },
  tw: { canonical: "textwidth", type: "number" },
  pcre: { canonical: "pcre", type: "boolean" },
  filetype: { canonical: "filetype", type: "string" },
  ft: { canonical: "filetype", type: "string" },
  langmap: { canonical: "langmap", type: "string" },
  lmap: { canonical: "langmap", type: "string" },
};

/** Mapping arguments we can safely drop vs. ones that change semantics. */
const STRIPPABLE_ARGS = /^<(silent|nowait|unique)>\s*/i;
const UNSUPPORTED_ARGS = /^<(expr|buffer|script)>/i;

function substituteLeader(s: string, leader: string): string {
  return s.replace(/<leader>/gi, leader).replace(/<localleader>/gi, leader);
}

export function applyVimrc(path: string, content: string): VimrcSummary {
  const summary: VimrcSummary = { path, applied: 0, skipped: [] };
  let leader = "\\";

  for (const raw of content.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith('"')) continue;

    const m = line.match(/^(\S+)\s*(.*)$/);
    if (!m) continue;
    const [, cmd, rest] = m;

    // let mapleader = "," (also g:mapleader / maplocalleader)
    if (cmd === "let") {
      const lm = rest.match(/^(?:g:)?map(?:local)?leader\s*=\s*(?:"(.*)"|'(.*)')\s*$/);
      if (lm) {
        const value = lm[1] ?? lm[2] ?? "\\";
        leader = value === "\\\\" ? "\\" : value;
        summary.applied++;
      } else {
        summary.skipped.push(`${line}: only mapleader assignments are supported`);
      }
      continue;
    }

    if (cmd === "set" || cmd === "setlocal") {
      for (const opt of rest.split(/\s+/).filter(Boolean)) {
        const om = opt.match(/^(no)?([a-z]+)(?:=(.*))?$/i);
        const known = om ? KNOWN_OPTIONS[om[2].toLowerCase()] : undefined;
        if (!om || !known) {
          summary.skipped.push(`set ${opt}: option not supported by the editor's vim engine`);
          continue;
        }
        const value =
          known.type === "boolean"
            ? om[1] !== "no"
            : known.type === "number"
              ? Number(om[3])
              : (om[3] ?? "");
        try {
          Vim.setOption(known.canonical, value);
          summary.applied++;
        } catch (e) {
          summary.skipped.push(`set ${opt}: ${e}`);
        }
      }
      continue;
    }

    if (cmd in UNMAP_MODES) {
      const lhs = rest.trim();
      if (!lhs) {
        summary.skipped.push(`${line}: missing key to unmap`);
        continue;
      }
      try {
        Vim.unmap(substituteLeader(lhs, leader), UNMAP_MODES[cmd] as string);
        summary.applied++;
      } catch {
        summary.skipped.push(`${line}: nothing to unmap`);
      }
      continue;
    }

    if (cmd in MAP_MODES) {
      let args = rest;
      while (STRIPPABLE_ARGS.test(args)) args = args.replace(STRIPPABLE_ARGS, "");
      if (UNSUPPORTED_ARGS.test(args)) {
        summary.skipped.push(`${line}: <expr>/<buffer>/<script> mappings are not supported`);
        continue;
      }
      const mm = args.match(/^(\S+)\s+(.+)$/);
      if (!mm) {
        summary.skipped.push(`${line}: expected "{lhs} {rhs}"`);
        continue;
      }
      const lhs = substituteLeader(mm[1], leader);
      const rhs = substituteLeader(mm[2].trim(), leader);
      if (/<plug>/i.test(rhs)) {
        summary.skipped.push(`${line}: <Plug> mappings need plugins`);
        continue;
      }
      const { mode, remap } = MAP_MODES[cmd];
      try {
        if (remap) {
          Vim.map(lhs, rhs, mode as string);
        } else {
          Vim.noremap(lhs, rhs, mode as string);
        }
        summary.applied++;
      } catch (e) {
        summary.skipped.push(`${line}: ${e}`);
      }
      continue;
    }

    summary.skipped.push(`${line}: unsupported command`);
  }

  return summary;
}
