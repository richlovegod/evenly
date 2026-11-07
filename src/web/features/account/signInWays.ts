// The ways an account signs in, as one phrase: 「Email 驗證碼、Apple 或密碼」 / "Email code, Apple
// or password". Used by 我的 (AccountPage.tsx signInWords) and the owner page (admin/adminText.ts).

/** "a、b 或 c" / "a, b or c", with a space where Chinese meets a Latin letter ("驗證碼或 Google"). */
export function oneOf(items: string[], zh: boolean): string {
  if (!zh) return items.length < 2 ? items.join('') : items.slice(0, -1).join(', ') + ' or ' + items[items.length - 1];
  const raw = items.length < 2 ? items.join('') : items.slice(0, -1).join('、') + '或' + items[items.length - 1];
  return raw.replace(/([A-Za-z0-9])(或)/g, '$1 $2').replace(/(或)([A-Za-z0-9])/g, '$1 $2');
}
