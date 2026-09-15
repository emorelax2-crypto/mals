/** Демо-данные: пара аккаунтов, переписка и подарок — чтобы сразу было что смотреть. */
import { db, q, uid, now, hashPassword, findOrCreateDm, insertMessage } from '../server/db.js';

const users = [
  { username: 'alice', name: 'Алиса',  emoji: '🦊', hue: 275, bio: 'Дизайню интерфейсы и коллекционирую подарки', balance: 1200 },
  { username: 'bob',   name: 'Боб',    emoji: '🐼', hue: 200, bio: 'Бэкенд, кофе, велосипед',                     balance: 800 },
  { username: 'kira',  name: 'Кира',   emoji: '🦄', hue: 330, bio: 'Продакт-менеджер',                            balance: 450 },
];

const ids = {};
for (const u of users) {
  const existing = q.userByUsername.get(u.username);
  if (existing) { ids[u.username] = existing.id; continue; }
  const { hash, salt } = hashPassword('123456');
  const id = uid();
  db.prepare(
    `INSERT INTO users (id, username, display_name, bio, avatar_emoji, avatar_hue, password_hash, password_salt, balance, created_at, last_seen)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, u.username, u.name, u.bio, u.emoji, u.hue, hash, salt, u.balance, now(), now() - 300000);
  ids[u.username] = id;
  console.log(`  ✓ @${u.username} (пароль 123456)`);
}

const dm = findOrCreateDm(ids.alice, ids.bob);
if (db.prepare('SELECT count(*) n FROM messages WHERE chat_id = ?').get(dm).n === 0) {
  const script = [
    [ids.alice, 'Привет! Попробовал новый мессенджер?'],
    [ids.bob, 'Ага, звонки работают прямо из браузера 👌'],
    [ids.alice, 'И подарки можно дарить за звёзды'],
    [ids.bob, 'Сейчас проверю 🎁'],
  ];
  script.forEach(([sender, body], i) => {
    const msg = insertMessage({ chatId: dm, senderId: sender, body });
    db.prepare('UPDATE messages SET created_at = ? WHERE id = ?').run(now() - (script.length - i) * 240000, msg.id);
  });

  const gift = q.giftById.get('rose');
  db.prepare('INSERT INTO user_gifts (id, owner_id, from_id, gift_id, note, anonymous, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(uid(), ids.alice, ids.bob, gift.id, 'Просто так :)', 0, now() - 120000);
  insertMessage({
    chatId: dm, senderId: ids.bob, kind: 'gift', body: 'Просто так :)',
    meta: { giftId: gift.id, name: gift.name, emoji: gift.emoji, price: gift.price, tier: gift.tier,
            toUserId: ids.alice, toName: 'Алиса', anonymous: false },
  });
  console.log('  ✓ демо-переписка и подарок');
}

console.log('\nГотово. Войдите как alice / 123456 или bob / 123456');
