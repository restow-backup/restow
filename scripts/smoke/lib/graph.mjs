/**
 * Microsoft Graph reads for check 4 (Microsoft 365 against the dev tenant):
 * the app registration's client credentials give a token; the helpers list
 * mail and OneDrive content and hash it, so the check can compare what was in
 * the test account with what a restore wrote into the second account.
 */
import { createHash } from "node:crypto";

const GRAPH = "https://graph.microsoft.com/v1.0";

export async function graphToken({ tenantId, clientId, clientSecret }) {
  const response = await fetch(`https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      scope: "https://graph.microsoft.com/.default",
      grant_type: "client_credentials",
    }),
  });
  const body = await response.json();
  if (!response.ok || !body.access_token) {
    throw new Error(`no Graph token: ${body.error_description?.split("\n")[0] ?? response.status}`);
  }
  return body.access_token;
}

async function graphGet(token, path, { raw = false } = {}) {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const response = await fetch(path.startsWith("http") ? path : `${GRAPH}${path}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (response.status === 429 || response.status === 503) {
      const wait = Number(response.headers.get("retry-after") ?? 2);
      await new Promise((resolve) => setTimeout(resolve, Math.min(wait, 30) * 1000));
      continue;
    }
    if (!response.ok) {
      throw new Error(`Graph ${path.split("?")[0]} answered ${response.status}`);
    }
    return raw ? Buffer.from(await response.arrayBuffer()) : response.json();
  }
  throw new Error(`Graph ${path.split("?")[0]} stayed throttled`);
}

async function pages(token, path) {
  const items = [];
  let next = path;
  while (next) {
    const page = await graphGet(token, next);
    items.push(...(page.value ?? []));
    next = page["@odata.nextLink"] ?? null;
  }
  return items;
}

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** `{ internetMessageId -> sha256 of the MIME }` of every message in a folder and below it. */
export async function mimeHashes(token, user, folderId) {
  const result = new Map();
  const visit = async (id) => {
    const messages = await pages(
      token,
      `/users/${encodeURIComponent(user)}/mailFolders/${id}/messages?$select=id,internetMessageId&$top=100`,
    );
    for (const message of messages) {
      const mime = await graphGet(
        token,
        `/users/${encodeURIComponent(user)}/messages/${message.id}/$value`,
        {
          raw: true,
        },
      );
      result.set(message.internetMessageId, sha256(mime));
    }
    for (const child of await pages(
      token,
      `/users/${encodeURIComponent(user)}/mailFolders/${id}/childFolders?$top=100`,
    )) {
      await visit(child.id);
    }
  };
  await visit(folderId);
  return result;
}

/** Every well-known mail folder of a user that holds the original mail (inbox, archive, sent). */
export async function originalFolders(token, user) {
  const ids = [];
  for (const name of ["inbox", "archive", "sentitems"]) {
    try {
      ids.push(
        (await graphGet(token, `/users/${encodeURIComponent(user)}/mailFolders/${name}?$select=id`))
          .id,
      );
    } catch {
      // The folder does not exist in this mailbox.
    }
  }
  return ids;
}

export async function folderByName(token, user, name) {
  const folders = await pages(
    token,
    `/users/${encodeURIComponent(user)}/mailFolders?$filter=${encodeURIComponent(`displayName eq '${name}'`)}&$select=id,displayName`,
  );
  return folders[0]?.id ?? null;
}

/** `{ relative path -> sha256 }` of the files below a OneDrive folder (`""` is the drive root). */
export async function driveHashes(token, user, folder = "") {
  const result = new Map();
  const base = `/users/${encodeURIComponent(user)}/drive`;
  const visit = async (relative) => {
    const path = relative
      ? `${base}/root:/${relative.split("/").map(encodeURIComponent).join("/")}:/children`
      : `${base}/root/children`;
    for (const item of await pages(token, `${path}?$top=200`)) {
      const child = relative ? `${relative}/${item.name}` : item.name;
      if (item.folder) {
        await visit(child);
      } else if (item.file) {
        result.set(
          child,
          sha256(await graphGet(token, `${base}/items/${item.id}/content`, { raw: true })),
        );
      }
    }
  };
  await visit(folder);
  return result;
}

/** Entries of `expected` that are missing from or different in `actual`. */
export function compareHashes(expected, actual) {
  const missing = [];
  const different = [];
  for (const [key, hash] of expected) {
    if (!actual.has(key)) {
      missing.push(key);
    } else if (actual.get(key) !== hash) {
      different.push(key);
    }
  }
  return { missing, different };
}
