// Web push for the home-screen app: VAPID keys live on the data volume, subscriptions too.
import fs from 'node:fs';
import path from 'node:path';
import webpush from 'web-push';

export function createPush(dir, subject = 'https://outreach-production-0cb261dc.up.railway.app') {
  const f = path.join(dir, 'out', 'push.json');
  fs.mkdirSync(path.dirname(f), { recursive: true });
  let S = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : {};
  if (!S.vapid) { S.vapid = webpush.generateVAPIDKeys(); S.subs = []; }
  S.subs ||= [];
  const save = () => fs.writeFileSync(f, JSON.stringify(S));
  save();
  webpush.setVapidDetails(subject, S.vapid.publicKey, S.vapid.privateKey);
  return {
    publicKey: () => S.vapid.publicKey,
    count: () => S.subs.length,
    subscribe(sub) {
      if (!sub?.endpoint || !sub?.keys?.p256dh || !sub?.keys?.auth) throw new Error('bad subscription');
      S.subs = S.subs.filter((s) => s.endpoint !== sub.endpoint).concat([{ endpoint: sub.endpoint, keys: sub.keys }]);
      save();
    },
    async send(msg) {
      const body = JSON.stringify(msg);
      for (const s of [...S.subs]) {
        try { await webpush.sendNotification(s, body, { TTL: 3600, urgency: 'high' }); }
        catch (e) { if (e.statusCode === 404 || e.statusCode === 410) { S.subs = S.subs.filter((x) => x.endpoint !== s.endpoint); save(); } }
      }
    },
  };
}
