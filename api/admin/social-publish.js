// api/admin/social-publish.js
//
// Publishes to the BookItMalta Facebook Page and/or Instagram via the Meta
// Graph API, using a never-expiring system-user Page token.
//
//   GET  /api/admin/social-publish?check=1   -> verify token + resolve Page/IG (no posting)
//   POST /api/admin/social-publish           -> publish { message, images[], videoUrl, targets }
//        - 0 images, no video           -> Facebook text post
//        - 1 image                      -> single photo (unchanged behaviour)
//        - 2..10 images                 -> Facebook album / Instagram carousel
//        - videoUrl (public mp4)        -> Facebook video + Instagram Reel
//   POST /api/admin/social-publish?action=poll { creation_id, target:'instagram' }
//        -> finish an async Instagram publish once Meta reports the container FINISHED
//
// Auth: header  Authorization: Bearer <SOCIAL_PUBLISH_SECRET>   (or { secret } in body).
//   The secret lives only in Vercel env + with Julian — never handled by Claude.
//
// Env:
//   META_PAGE_TOKEN       system-user Page token (Sensitive)
//   META_PAGE_ID          BookItMalta Facebook Page id
//   META_IG_USER_ID       (optional) IG business account id — resolved from the Page if absent
//   SOCIAL_PUBLISH_SECRET shared secret required to call this endpoint
//
// Notes:
//   - Instagram video/carousel processes asynchronously. The single POST creates
//     the container(s); for video (which can take a while) it returns a creation_id
//     and the browser polls ?action=poll until FINISHED, then this publishes it.
//     Each call stays well inside the function budget — no long-held request.
//   - Stores nothing; sends no PII. Posting is gated behind the secret + Julian's preview.

const GRAPH = 'https://graph.facebook.com/v21.0';

function isAuthed(req) {
  const secret = process.env.SOCIAL_PUBLISH_SECRET || '';
  if (!secret) return false; // fail closed if not configured
  const hdr = String(req.headers['authorization'] || '');
  const bearer = hdr.startsWith('Bearer ') ? hdr.slice(7) : '';
  const bodySecret = (req.body && req.body.secret) || '';
  return bearer === secret || bodySecret === secret;
}

async function graph(path, params, method) {
  const m = method || 'POST';
  let url = `${GRAPH}/${path}`;
  let opts = { method: m };
  if (m === 'GET') {
    url += (url.includes('?') ? '&' : '?') + new URLSearchParams(params).toString();
  } else {
    opts.headers = { 'Content-Type': 'application/x-www-form-urlencoded' };
    opts.body = new URLSearchParams(params).toString();
  }
  const resp = await fetch(url, opts);
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok || data.error) {
    const e = data.error || {};
    throw new Error(`Graph ${m} ${path} failed: ${e.message || resp.status}`);
  }
  return data;
}

async function resolveIgUserId(pageId, token) {
  if (process.env.META_IG_USER_ID) return process.env.META_IG_USER_ID;
  const data = await graph(`${pageId}`, { fields: 'instagram_business_account', access_token: token }, 'GET');
  return data.instagram_business_account && data.instagram_business_account.id;
}

async function getPageToken(pageId, userToken) {
  // META_PAGE_TOKEN is a system-user token. Reading the Page works with it, but
  // PUBLISHING must use the Page's OWN access token. Derive it.
  const data = await graph(`${pageId}`, { fields: 'access_token', access_token: userToken }, 'GET');
  if (!data.access_token) {
    throw new Error('Could not derive a Page access token from META_PAGE_TOKEN. The system user needs Full control of the Page plus pages_show_list + pages_manage_posts.');
  }
  return data.access_token;
}

// Poll a media container until it finishes processing (or the budget runs out).
// Returns 'FINISHED' | 'PENDING'; throws on ERROR/EXPIRED.
async function pollContainer(containerId, token, maxMs) {
  const deadline = Date.now() + (maxMs || 6500);
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1500));
    let st;
    try { st = await graph(`${containerId}`, { fields: 'status_code', access_token: token }, 'GET'); }
    catch (e) { continue; }
    if (st.status_code === 'FINISHED') return 'FINISHED';
    if (st.status_code === 'ERROR' || st.status_code === 'EXPIRED') {
      throw new Error('Instagram rejected the media (status ' + st.status_code + ') — check the URL is public and a supported format.');
    }
  }
  return 'PENDING';
}

// ---------- Facebook ----------

async function publishFacebookPhotos(pageId, token, message, images) {
  if (!images || images.length === 0) {
    return graph(`${pageId}/feed`, { message: message || '', access_token: token });
  }
  if (images.length === 1) {
    return graph(`${pageId}/photos`, { url: images[0], caption: message || '', access_token: token });
  }
  // 2+ -> upload each unpublished, then one feed story attaching them (album).
  const ids = [];
  for (const url of images) {
    const photo = await graph(`${pageId}/photos`, { url, published: 'false', access_token: token });
    ids.push(photo.id);
  }
  const params = { message: message || '', access_token: token };
  ids.forEach((id, i) => { params[`attached_media[${i}]`] = JSON.stringify({ media_fbid: id }); });
  return graph(`${pageId}/feed`, params);
}

async function publishFacebookVideo(pageId, token, message, videoUrl) {
  // FB pulls and transcodes the video server-side; the call returns a video id
  // immediately and the post appears once processing completes. No long wait here.
  return graph(`${pageId}/videos`, { file_url: videoUrl, description: message || '', access_token: token });
}

// ---------- Instagram ----------

async function publishInstagramPhotos(pageId, token, message, images) {
  if (!images || images.length === 0) throw new Error('Instagram requires a public image URL');
  const igId = await resolveIgUserId(pageId, token);
  if (!igId) throw new Error('No Instagram business account linked to this Page');

  if (images.length === 1) {
    const container = await graph(`${igId}/media`, { image_url: images[0], caption: message || '', access_token: token });
    await new Promise((r) => setTimeout(r, 6000));
    let published;
    try {
      published = await graph(`${igId}/media_publish`, { creation_id: container.id, access_token: token });
    } catch (e) {
      throw new Error('Instagram media still processing — click Publish again in a few seconds (' + e.message + ')');
    }
    return { container_id: container.id, id: published.id };
  }

  // Carousel — each image a child container, then a CAROUSEL parent.
  const childIds = [];
  for (const url of images) {
    const child = await graph(`${igId}/media`, { image_url: url, is_carousel_item: 'true', access_token: token });
    childIds.push(child.id);
  }
  const parent = await graph(`${igId}/media`, {
    media_type: 'CAROUSEL', children: childIds.join(','), caption: message || '', access_token: token,
  });
  const state = await pollContainer(parent.id, token, 4500);
  if (state !== 'FINISHED') {
    return { pending: true, creation_id: parent.id, kind: 'carousel' };
  }
  const published = await graph(`${igId}/media_publish`, { creation_id: parent.id, access_token: token });
  return { container_id: parent.id, children: childIds, id: published.id };
}

async function createInstagramReel(pageId, token, message, videoUrl) {
  const igId = await resolveIgUserId(pageId, token);
  if (!igId) throw new Error('No Instagram business account linked to this Page');
  const container = await graph(`${igId}/media`, {
    media_type: 'REELS', video_url: videoUrl, caption: message || '', access_token: token,
  });
  // Reels transcode slowly — poll briefly; if not ready, hand the creation_id to
  // the client to finish via ?action=poll (avoids holding the function open).
  const state = await pollContainer(container.id, token, 5000);
  if (state === 'FINISHED') {
    const published = await graph(`${igId}/media_publish`, { creation_id: container.id, access_token: token });
    return { container_id: container.id, id: published.id };
  }
  return { pending: true, creation_id: container.id, kind: 'reel' };
}

// Finish an async IG publish: check the container; publish if FINISHED.
async function pollAndPublishInstagram(pageId, token, creationId) {
  const igId = await resolveIgUserId(pageId, token);
  if (!igId) throw new Error('No Instagram business account linked to this Page');
  const state = await pollContainer(creationId, token, 7000);
  if (state !== 'FINISHED') return { state: 'processing', creation_id: creationId };
  const published = await graph(`${igId}/media_publish`, { creation_id: creationId, access_token: token });
  return { state: 'published', id: published.id };
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');

  if (req.method === 'OPTIONS') return res.status(204).end();

  if (!isAuthed(req)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const token = process.env.META_PAGE_TOKEN;
  const pageId = process.env.META_PAGE_ID;
  if (!token || !pageId) {
    return res.status(500).json({ error: 'META_PAGE_TOKEN / META_PAGE_ID not configured' });
  }

  // GET ?check — verify wiring without posting
  if (req.method === 'GET') {
    try {
      const pageToken = await getPageToken(pageId, token);
      const page = await graph(`${pageId}`, { fields: 'id,name', access_token: pageToken }, 'GET');
      let instagram = null;
      try {
        const igId = await resolveIgUserId(pageId, pageToken);
        if (igId) instagram = await graph(`${igId}`, { fields: 'id,username', access_token: pageToken }, 'GET');
      } catch (e) { instagram = { error: e.message }; }
      return res.status(200).json({ ok: true, page, instagram, pageToken: 'derived' });
    } catch (e) {
      return res.status(502).json({ ok: false, error: e.message });
    }
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  let pageToken;
  try { pageToken = await getPageToken(pageId, token); }
  catch (e) { return res.status(502).json({ ok: false, results: { error: e.message } }); }

  const body = req.body || {};

  // --- async finish: poll an Instagram container, publish when ready ---
  if ((req.query && req.query.action === 'poll') || body.action === 'poll') {
    const creationId = (body.creation_id || '').toString();
    if (!creationId) return res.status(400).json({ error: 'creation_id required' });
    try {
      const out = await pollAndPublishInstagram(pageId, pageToken, creationId);
      return res.status(200).json({ ok: true, instagram: out });
    } catch (e) {
      return res.status(502).json({ ok: false, instagram: { state: 'error', error: e.message } });
    }
  }

  // --- normal publish ---
  const message = (body.message || '').toString();
  const videoUrl = body.videoUrl ? body.videoUrl.toString() : '';
  // Accept images[] (preferred) or legacy single imageUrl.
  let images = Array.isArray(body.images) ? body.images.map((s) => String(s).trim()).filter(Boolean) : [];
  if (images.length === 0 && body.imageUrl) images = [String(body.imageUrl).trim()].filter(Boolean);
  if (images.length > 10) images = images.slice(0, 10);

  let targets = body.targets;
  if (!Array.isArray(targets) || targets.length === 0) targets = ['facebook'];
  targets = targets.map((t) => String(t).toLowerCase());
  const wantFb = targets.includes('facebook') || targets.includes('fb');
  const wantIg = targets.includes('instagram') || targets.includes('ig');

  const isVideo = !!videoUrl;
  if (!message && !images.length && !isVideo) {
    return res.status(400).json({ error: 'Provide a message, image(s), or a video' });
  }

  const results = {};
  let anyOk = false;

  if (wantFb) {
    try {
      const r = isVideo
        ? await publishFacebookVideo(pageId, pageToken, message, videoUrl)
        : await publishFacebookPhotos(pageId, pageToken, message, images);
      results.facebook = { ok: true, ...r }; anyOk = true;
    } catch (e) { results.facebook = { ok: false, error: e.message }; }
  }

  if (wantIg) {
    try {
      const r = isVideo
        ? await createInstagramReel(pageId, pageToken, message, videoUrl)
        : await publishInstagramPhotos(pageId, pageToken, message, images);
      results.instagram = { ok: true, ...r }; anyOk = true;
    } catch (e) { results.instagram = { ok: false, error: e.message }; }
  }

  return res.status(anyOk ? 200 : 502).json({ ok: anyOk, results });
};
