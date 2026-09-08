export {
  SKILL_SIDECAR,
  expandHome,
  hashFileMap,
  hashSkillDir,
  isDirectory,
  isIgnoredSkillFile,
  normalizePortablePath,
  parentDirOf,
  readSkillDirFiles,
} from "./files.js";
export {
  buildSidecar,
  normalizeSidecarTimestamp,
  readSidecar,
  serializeSidecar,
  sidecarCarriesFullState,
  sidecarMarkersMatch,
  sidecarMatchesRemoteMarkers,
  writeSidecar,
  type SkillSidecar,
  type SkillSidecarIdentity,
} from "./sidecar.js";
export { replaceSkillDirAtomically, type SkillDirWritePlan } from "./atomic.js";
export { acquireSkillsPullLock, skillsPullLockPath, type SkillsPullLock } from "./lock.js";
export {
  EmptySkillSnapshotError,
  MissingRequiredSkillFileError,
  buildSnapshotFileMap,
  detectSkillDirDrift,
  materializeSkill,
  type MaterializeSkillInput,
  type MaterializeSkillResult,
  type MaterializeSkillStatus,
  type SkillSidecarBookkeeping,
  type SkillSnapshotFile,
} from "./materialize.js";
