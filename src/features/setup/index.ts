// Setup: getting Ableton talking to Recall, and keeping it that way.
//
// ─── HOW TO MOUNT THE NOTICE ────────────────────────────────────────────────
//
// Everything here is built and tested. The only step left is three lines in the
// app shell, deliberately not applied yet because AppShell.tsx and App.tsx were
// being worked on elsewhere when this landed.
//
// In App.tsx, alongside the existing connection poll:
//
//   const [install, setInstall] = useState<InstallStatus | null>(null);
//   // Cheap: one stat against one known path. Do NOT call
//   // detect_bridge_install_targets on a poll — that one probes every drive
//   // letter and blocks on offline network drives (install.rs::user_library_candidates).
//   invoke<InstallStatus>("is_remote_script_installed", { targetRoot: libraryRoot })
//
//   const setupState = resolveSetupState({
//     installed: install?.installed ?? false,
//     connected: connection.connected,
//     runningVersion: connection.bridge_version,   // arrives on the heartbeat
//     shippedVersion: detection?.script_version,   // parsed from the bundled script
//   });
//
// Then render <SetupNoticeBar> inside AppShell, ABOVE the surface content and
// below the top bar, so it is present on every screen:
//
//   <SetupNoticeBar
//     state={setupState}
//     runningVersion={connection.bridge_version}
//     shippedVersion={shippedVersion}
//     onOpenSetup={() => onChangeSurface("setup")}
//   />
//
// It renders nothing in the `ready` and `first-run` states, so mounting it
// unconditionally is correct — `first-run` is handled by the landing screen,
// which owns the whole window.
//
// ─── WHY A SHELL-LEVEL STRIP ────────────────────────────────────────────────
//
// Nobody opens Setup once setup is done. A producer whose Ableton is running an
// older control surface has no reason to go looking, and the symptom — an update
// quietly capturing less than it should — gives them no reason either. A notice
// that only rendered on the Setup screen would be decoration.

export { SetupNoticeBar } from "./SetupNotice";
export {
  isScriptStale,
  needsShellNotice,
  resolveSetupState,
  setupNotice,
  type SetupFacts,
  type SetupNotice,
  type SetupState,
} from "./setupState";
