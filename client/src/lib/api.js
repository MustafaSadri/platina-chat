export class ApiError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

let onUnauthorized = () => {};
export const setUnauthorizedHandler = (fn) => { onUnauthorized = fn; };

export async function api(method, url, body, { signal } = {}) {
  const isForm = body instanceof FormData;
  let res;
  try {
    res = await fetch(`/api${url}`, {
      method,
      credentials: 'same-origin',
      headers: body && !isForm ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? (isForm ? body : JSON.stringify(body)) : undefined,
      signal,
    });
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    throw new ApiError(0, 'Network error. Check your connection.', 'NETWORK');
  }
  let data = null;
  try { data = await res.json(); } catch { /* empty body */ }
  if (!res.ok) {
    if (res.status === 401 && !url.startsWith('/auth/login')) onUnauthorized();
    throw new ApiError(res.status, data?.error || `Request failed (${res.status})`, data?.code);
  }
  return data;
}

export const get = (url, opts) => api('GET', url, undefined, opts);
export const post = (url, body) => api('POST', url, body || {});
export const patch = (url, body) => api('PATCH', url, body);
export const put = (url, body) => api('PUT', url, body);
export const del = (url) => api('DELETE', url);

/** Upload with progress (fetch has no upload progress), metadata fields first. */
export function upload(chatId, file, fields = {}, onProgress = () => {}) {
  return new Promise((resolve, reject) => {
    const fd = new FormData();
    for (const [k, v] of Object.entries(fields)) if (v !== undefined && v !== null) fd.append(k, String(v));
    fd.append('file', file, file.name || 'file');
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api/chats/${chatId}/files`);
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.onload = () => {
      let data = null;
      try { data = JSON.parse(xhr.responseText); } catch { /* ignore */ }
      if (xhr.status >= 200 && xhr.status < 300) resolve(data.file);
      else reject(new ApiError(xhr.status, data?.error || 'Upload failed', data?.code));
    };
    xhr.onerror = () => reject(new ApiError(0, 'Network error during upload.', 'NETWORK'));
    xhr.send(fd);
  });
}
