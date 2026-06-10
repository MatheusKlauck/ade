import { listen } from "@tauri-apps/api/event";

export async function subscribeNotify(
  cb: (payload: {
    level: string;
    code: string;
    message: string;
  }) => void
) {
  return listen<{ level: string; code: string; message: string }>("evt:notify", (ev) => {
    cb(ev.payload);
  });
}
