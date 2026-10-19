// 頭像照片 / Profile photo on the 個人資料 card: your face as others see it, with 上傳照片, or 換照片
// and 移除照片 once there is a photo. A picked photo is center-cropped and shrunk to 256 x 256 here
// (avatarPhoto.ts) and saved right away, without the card's 儲存; the store then refreshes the
// dashboard, so every avatar shows the change.

import { useRef, useState, type ChangeEvent } from 'react';
import type { UserDTO } from '../../../shared/types';
import { Avatar } from '../../components/Avatar';
import { Button } from '../../components/Button';
import { useT } from '../../lib/i18n';
import { actions } from '../../lib/store';
import { showToast } from '../../lib/toast';
import { cx, ErrorLine } from '../auth/Receipt';
import { avatarErrorText, avatarImage } from './avatarPhoto';
import s from './Account.module.css';

/** `name`: the name the card shows now (the initial when there is no photo). */
export function PhotoField({ user, name }: { user: UserDTO; name: string }) {
  const { t } = useT();
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState<'upload' | 'remove' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const has = !!user.avatar;

  async function upload(file: File) {
    setBusy('upload');
    setError(null);
    try {
      await actions.setAvatar(await avatarImage(file));
      showToast({ message: t('已換上新照片', 'Photo updated'), kind: 'success' });
    } catch (err) {
      setError(avatarErrorText(err));
    } finally {
      setBusy(null);
    }
  }

  async function remove() {
    setBusy('remove');
    setError(null);
    try {
      await actions.removeAvatar();
      showToast({ message: t('已移除照片', 'Photo removed'), kind: 'success' });
    } catch (err) {
      setError(avatarErrorText(err));
    } finally {
      setBusy(null);
    }
  }

  const onFile = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // the same photo can be picked again, and the input lets go of this one
    if (file) void upload(file);
  };

  return (
    <div className={cx(s.field, s.photoField)}>
      <p className={s.label}>{t('頭像照片', 'Profile photo')}</p>
      <div className={s.photoRow}>
        <Avatar name={name} color={user.color} userId={user.id} avatar={user.avatar} size={56} ring />
        <div className={s.photoActions}>
          {/* Opened right in the tap (iOS shows the picker only then): the photo library or the camera. */}
          <Button
            size="sm"
            icon="camera"
            loading={busy === 'upload'}
            disabled={busy === 'remove'}
            onClick={() => fileRef.current?.click()}
            data-testid="account-photo"
          >
            {has ? t('換照片', 'Change photo') : t('上傳照片', 'Upload photo')}
          </Button>
          {has ? (
            <Button
              size="sm"
              variant="ghost"
              icon="trash"
              loading={busy === 'remove'}
              disabled={busy === 'upload'}
              onClick={() => void remove()}
              data-testid="account-photo-remove"
            >
              {t('移除照片', 'Remove photo')}
            </Button>
          ) : null}
        </div>
      </div>
      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        className={s.fileInput}
        tabIndex={-1}
        aria-hidden="true"
        onChange={onFile}
        data-testid="account-photo-file"
      />
      <p className={s.hint}>{t('同群組的朋友都看得到', 'Everyone in your groups can see this')}</p>
      {error && <ErrorLine>{error}</ErrorLine>}
    </div>
  );
}
