// One normalizer for skill file paths across the server and the CLI — the two
// sides key their inventories off identical strings or the comparison is a lie.
export { normalizePortablePath } from "@paperclipai/skill-materializer";
