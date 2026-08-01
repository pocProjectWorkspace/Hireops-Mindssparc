"use client";

import { IrisAvatar } from "./IrisAvatar";
import { IrisDrawer } from "./IrisDrawer";
import { useIrisContext, useIrisControls } from "./IrisProvider";

/**
 * IrisLauncher (IRIS-A2) — the "Ask Iris" trigger + drawer mount. A small
 * client island so AppShell (a server component) can offer Iris on every page
 * without becoming a client component itself. Reads the page context from
 * IrisProvider and passes it to the drawer for the suggested-action default.
 * The open-state lives in IrisProvider (ONBOARD-1) so other surfaces can open
 * the drawer too.
 */
export function IrisLauncher() {
  const context = useIrisContext();
  const { isOpen, openIris, closeIris } = useIrisControls();
  return (
    <>
      <button
        type="button"
        onClick={() => openIris()}
        aria-haspopup="dialog"
        className="inline-flex h-9 items-center gap-1.5 rounded-button border border-brand-200 bg-brand-50 px-3 text-sm font-medium text-brand-700 transition-colors hover:border-brand-300 hover:bg-brand-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500"
      >
        <IrisAvatar size={20} />
        Ask Iris
      </button>
      <IrisDrawer open={isOpen} onClose={closeIris} context={context} />
    </>
  );
}
