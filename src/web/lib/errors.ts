// Turn any error into a short message for people, in the current language.

import { ApiError } from './api';
import { zhJoin } from './describe';
import { t } from './i18n';

export function errorMessage(e: unknown): string {
  if (e instanceof ApiError) {
    switch (e.code) {
      case 'offline': return t('沒有網路連線，請稍後再試。', 'No connection. Try again when you are online.');
      case 'rate_limited':
        // POST /api/groups, /groups/:gid/members, /friends: 30 accounts linked by email a day.
        if ((e.details as { scope?: unknown } | undefined)?.scope === 'links') {
          return t('今天用 Email 加的人太多了，明天再試，或改傳邀請連結。', 'You have added too many people by email today. Try again tomorrow, or send the invite link.');
        }
        return t('嘗試太多次了，請過幾分鐘再試。', 'Too many attempts. Wait a few minutes and try again.');
      case 'invalid_credentials': return t('Email 或密碼不正確。', 'That email and password do not match.');
      case 'email_taken': return t('這個 Email 已經有帳號了，請直接登入。', 'That email already has an account. Sign in instead.');
      case 'weak_password': return t('密碼至少要 8 個字元。', 'Use at least 8 characters for the password.');
      case 'password_required': return t('使用 Email 時也要設定密碼。', 'Add a password to use with this email.');
      case 'balance_not_zero': {
        // At a balance of 0 the settle-up plan can still name the member (簡化債務 off keeps debts
        // pair by pair; review B2-01, W7-contract-03): the details say so, and what clears it.
        const d = (e.details ?? {}) as { net?: unknown; transfers?: unknown };
        if (d.net === 0 && typeof d.transfers === 'number' && d.transfers > 0) {
          return t('結算建議裡還有要付或要收的錢。先記錄這些還款，或開啟「簡化債務」。', 'The settle-up plan still has payments for this member. Record them, or turn on Simplify debts.');
        }
        return t('要先結清才能離開或移除這位成員。', 'Settle up first: this member still has a balance.');
      }
      case 'code_invalid': return t('這個代碼或連結無效或已過期。', 'That code or link is not valid or has expired.');
      case 'already_member': return t('你已經在這個群組裡了。', 'You are already in this group.');
      case 'member_claimed': return t('這位成員已經有人認領了。', 'Someone already claimed this member.');
      case 'last_admin': return t('請先指定另一位管理員。', 'Make someone else an admin first.');
      case 'limit_reached': {
        // Which limit, from details.limit (shared/types.ts LimitReachedDetails, review B2-10). A
        // receipt's third photo has its own words (editorText.ts); an older Worker sends no details.
        const d = (e.details ?? {}) as { limit?: unknown; self?: unknown; name?: unknown };
        switch (d.limit) {
          case 'groups': {
            if (d.self === true) return t('你已經在 200 個群組裡了，沒辦法再加入。', 'You are already in 200 groups, the most there can be.');
            const name = typeof d.name === 'string' && d.name ? d.name : t('對方', 'This person');
            return t(zhJoin(name, '已經在 200 個群組裡了，沒辦法再加入。'), name + ' is already in 200 groups, the most there can be.');
          }
          case 'pair_members': return t('兩人帳本只能有兩個人。要加更多人，請建立群組。', 'A friend ledger has two people. To add more people, create a group.');
          case 'members': return t('一個群組最多 50 位成員。', 'A group can have at most 50 members.');
          case 'entries': return t('一個群組最多記 5,000 筆。', 'A group can hold at most 5,000 entries.');
          case 'entry_rows': return t('這個群組已經存了 20,000 筆（包括刪除的），沒辦法再新增。', 'This group already keeps 20,000 entries, deleted ones included, so no more can be added.');
        }
        return t('已達上限。', 'You reached the limit for this.');
      }
      case 'not_found': return t('找不到這個項目，可能已被刪除，或你不在這個群組。', 'Not found. It may have been deleted, or you are not in this group.');
      case 'forbidden': return t('你沒有權限做這件事。', 'You are not allowed to do that.');
      case 'unauthorized': return t('請重新登入。', 'Please sign in again.');
      case 'session_changed': return t('另一個分頁換了登入的帳號，正在重新載入。', 'Another tab signed in to a different account. Reloading.');
      case 'already_signed_in': return t('這個瀏覽器已經登入了，請重新整理頁面。', 'This browser is already signed in. Reload the page.');
      case 'validation': return t('有欄位格式不正確，請檢查後再試。', 'Some fields are not valid. Check them and try again.');
      case 'payload_too_large': return t('資料太大了。', 'That is too much data at once.');
      case 'fx_unavailable': return t('暫時拿不到匯率，請手動輸入。', 'Exchange rates are unavailable right now. Enter the rate by hand.');
      case 'email_quota': return t('今天的驗證信已經寄完了，請明天再試，或用其他裝置的登入碼。', "Today's sign-in emails are used up. Try again tomorrow, or use a code from another device.");
      case 'email_unavailable': return t('現在寄不出驗證信，請稍後再試，或用其他裝置的登入碼。', "We can't send the email right now. Try again in a moment, or use a code from another device.");
      case 'name_required': return t('請輸入你的名字。', 'Enter your name.');
      case 'email_unconfirmed': return t('請先用驗證碼確認這個 Email。', 'Confirm this email with a code first.');
      case 'receipts_quota': return t('今天的收據照片上傳額度用完了，明天再試。', "Today's receipt photo uploads are used up. Try again tomorrow.");
      case 'receipts_full': return t('收據照片的空間滿了，這張存不下。', 'The space for receipt photos is full, so this one cannot be kept.');
      case 'own_invite': return t('這是你自己的邀請連結。', 'This is your own invite link.');
      case 'server_error': return t('伺服器出了點問題，請稍後再試。', 'Something went wrong on the server. Try again soon.');
      case 'conflict':
        // The group currency changed under the save (PUT and import after two changes in a row, or
        // PATCH currency when another change or an old-currency entry landed first; review B2-06).
        if ((e.details as { code?: unknown } | undefined)?.code === 'currency_changed') {
          return t('群組的幣別剛被改過，請再試一次。', 'The group currency just changed. Try again.');
        }
        // A queued edit someone else's change clashed with (409, routes/expenses.ts editConflict):
        // shown as 同步失敗：… beside 重試 / 放棄 (the iPhone app, which saves in the form, says 請重新打開再改).
        return t('別人剛改過這筆，請先放棄這次的修改，再重新打開來改。', 'Someone else changed this after you opened it. Discard this change, then open it again to edit it.');
      // Their message is the server's or the browser's own English (The queued photo cannot be read,
      // TypeError: Load failed), never meant for people (as in the iPhone app).
      case 'bad_request':
      case 'unknown':
        return t('發生錯誤，請稍後再試。', 'Something went wrong. Try again later.');
      // The client's own codes (unsynced) carry a message already in the current language.
      default: return e.message || t('發生錯誤。', 'Something went wrong.');
    }
  }
  if (e instanceof Error && e.message) return e.message;
  return t('發生錯誤。', 'Something went wrong.');
}
