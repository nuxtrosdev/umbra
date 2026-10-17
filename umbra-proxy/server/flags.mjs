/* Command-line flags, because `UMBRA_TRACE=1 npm start` is a Unix shell
 * idiom and not a universal one.
 *
 * On cmd.exe that line is read as a command named "UMBRA_TRACE=1", which
 * does not exist; PowerShell wants `$env:X="1"` and bash wants the prefix.
 * Asking the person running the server to know which shell they are in,
 * before they can turn on the diagnostic that tells them what is wrong, is
 * a poor trade. A flag works identically in all three:
 *
 *     npm start -- --trace
 *
 * Environment variables keep working and are not overwritten: a flag only
 * fills in a value that was not already set, so existing deployments and
 * scripts behave exactly as before.
 */

export const HELP = `umbra — a web proxy

  npm start [-- flags]

  --trace            log every upstream exchange and every error raised
                     inside a proxied page (same as UMBRA_TRACE=1)
  --port <n>         listen on this port (default 4173)
  --host <addr>      bind address (default 0.0.0.0 — all interfaces;
                     use 127.0.0.1 to refuse other machines)
  --providers <list> comma-separated extraction order
  --help             this text
`;

/**
 * Translate argv into environment variables. Pure: takes the argv array and
 * an env object, mutates only the env it is handed.
 * @returns {{ help: boolean, unknown: string[] }}
 */
export function applyFlags(argv = [], env = {}) {
  const args = argv.slice();
  const unknown = [];
  let help = false;

  const setIfUnset = (key, value) => {
    if (env[key] === undefined || env[key] === '') env[key] = value;
  };

  for (let i = 0; i < args.length; i++) {
    const a = String(args[i]);
    if (!a.startsWith('-')) continue;
    /* --port=4173 and --port 4173 are both common; accept both. */
    const eq = a.indexOf('=');
    const name = (eq === -1 ? a : a.slice(0, eq)).replace(/^--?/, '').toLowerCase();
    const inline = eq === -1 ? null : a.slice(eq + 1);
    const next = () => (inline !== null ? inline : (args[++i] !== undefined ? String(args[i]) : ''));

    switch (name) {
      case 'trace': case 'v': case 'verbose': setIfUnset('UMBRA_TRACE', '1'); break;
      case 'port': case 'p': setIfUnset('PORT', next()); break;
      case 'host': case 'h': setIfUnset('UMBRA_HOST', next()); break;
      case 'providers': setIfUnset('UMBRA_PROVIDERS', next()); break;
      case 'help': case '?': help = true; break;
      default: unknown.push(a);
    }
  }
  return { help, unknown };
}

/* Applied on import so the modules that read process.env below this point
   see the flags. Importing this module first is therefore deliberate. */
const result = applyFlags(process.argv.slice(2), process.env);
if (result.help) {
  console.log(HELP);
  process.exit(0);
}
for (const u of result.unknown) console.error(`umbra: ignoring unknown flag ${u} (try --help)`);

export default result;
