/**
 * Starts the download of a prepared ZIP. The archive streams from the server,
 * so the browser is sent to its address and saves it to disk while it comes in;
 * nothing is held in the page. The address answers with an attachment, so the
 * page stays where it is. An anchor with `download` is the one way that also
 * keeps the page when the server refuses (the browser reports a failed
 * download instead of replacing the page with the error).
 */
export function startBrowserDownload(url: string): void {
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = "";
  anchor.rel = "noopener";
  anchor.hidden = true;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
}
