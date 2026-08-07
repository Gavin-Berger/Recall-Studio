import { needsShellNotice, setupNotice, type SetupState } from "./setupState";
import "./SetupNotice.css";

type SetupNoticeBarProps = {
  state: SetupState;
  runningVersion: string | null;
  shippedVersion: string | null;
  onOpenSetup: () => void;
};

/**
 * The one thing in the app that follows the producer around.
 *
 * WHY IT LIVES IN THE SHELL AND NOT ON THE SETUP SCREEN: nobody opens Setup once
 * setup is done. A producer whose Ableton is running last month's control surface
 * has no reason to go looking, and the symptom — an update quietly capturing less
 * than it should — gives them no reason either. If this only rendered on the
 * screen they never visit, it would be decoration.
 *
 * NOT DISMISSIBLE, ON PURPOSE. There is no "later" that improves anything: both
 * states clear themselves the moment the producer does the thing (restart Live,
 * or finish setup), so a dismiss button could only ever hide a real problem. It
 * is a strip rather than a modal so it never blocks work while it waits.
 */
export function SetupNoticeBar({
  state,
  runningVersion,
  shippedVersion,
  onOpenSetup,
}: SetupNoticeBarProps) {
  if (!needsShellNotice(state)) return null;

  const notice = setupNotice(state, runningVersion, shippedVersion);
  if (!notice) return null;

  return (
    // role=status, not alert: this is a standing condition the producer should
    // notice, not an interruption demanding they stop what they are doing.
    <div className="setup-notice" role="status">
      <div className="setup-notice__text">
        <strong className="setup-notice__title">{notice.title}</strong>
        <span className="setup-notice__detail">{notice.detail}</span>
      </div>
      {notice.action && (
        <button type="button" className="setup-notice__action" onClick={onOpenSetup}>
          {notice.action}
        </button>
      )}
    </div>
  );
}
