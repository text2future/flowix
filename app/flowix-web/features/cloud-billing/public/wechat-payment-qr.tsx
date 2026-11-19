'use client';

import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { useI18n } from '@/lib/i18n';
import { dialogActionClasses } from '@shared/ui/dialog-styles';

export function WechatPaymentIcon() {
  return <svg aria-hidden="true" className="h-4 w-4 shrink-0 text-green-500" viewBox="0 0 24 24" fill="currentColor"><path d="M8.691 2.188C3.891 2.188 0 5.476 0 9.53c0 2.212 1.17 4.203 3.002 5.55a.59.59 0 01.213.665l-.39 1.48c-.019.07-.048.141-.048.213 0 .163.13.295.29.295a.326.326 0 00.167-.054l1.903-1.114a.864.864 0 01.717-.098 10.16 10.16 0 002.837.403c.276 0 .543-.027.811-.05-.857-2.578.157-4.972 1.932-6.446 1.703-1.415 3.882-1.98 5.853-1.838-.576-3.583-4.196-6.348-8.596-6.348zM5.785 5.991c.642 0 1.162.529 1.162 1.18a1.17 1.17 0 01-1.162 1.178A1.17 1.17 0 014.623 7.17c0-.651.52-1.18 1.162-1.18zm5.813 0c.642 0 1.162.529 1.162 1.18a1.17 1.17 0 01-1.162 1.178 1.17 1.17 0 01-1.162-1.178c0-.651.52-1.18 1.162-1.18zm5.34 2.867c-1.797-.052-3.746.512-5.28 1.786-1.72 1.428-2.687 3.72-1.78 6.22.942 2.453 3.666 4.229 6.884 4.229.826 0 1.622-.12 2.361-.336a.722.722 0 01.598.082l1.584.926a.272.272 0 00.14.045c.134 0 .24-.111.24-.247 0-.06-.023-.12-.038-.177l-.327-1.233a.582.582 0 01-.023-.156.49.49 0 01.201-.398C23.024 18.48 24 16.82 24 14.98c0-3.21-2.931-5.837-7.062-6.122zm-2.036 2.96c.535 0 .969.44.969.982a.976.976 0 01-.969.983.976.976 0 01-.969-.983c0-.542.434-.982.97-.982zm4.844 0c.535 0 .969.44.969.982a.976.976 0 01-.969.983.976.976 0 01-.969-.983c0-.542.434-.982.97-.982z" /></svg>;
}

export function WechatPaymentQr({ url, svg }: { url: string; svg?: string | null }) {
  const { t } = useI18n();
  const [qrSvg, setQrSvg] = useState(svg ?? '');
  const [failed, setFailed] = useState(!svg);
  const [retrying, setRetrying] = useState(false);

  useEffect(() => { setQrSvg(svg ?? ''); setFailed(!svg); }, [svg, url]);

  const retry = async () => {
    if (retrying) return;
    setRetrying(true);
    try {
      const next = await QRCode.toString(url, { type: 'svg', margin: 2, errorCorrectionLevel: 'M' });
      setQrSvg(next);
      setFailed(false);
    } catch { setFailed(true); }
    finally { setRetrying(false); }
  };

  if (failed) {
    return (
      <div role="alert" className="mx-auto flex min-h-48 w-full flex-col items-center justify-center gap-3 text-center text-sm text-[var(--muted-foreground)]">
        <p>{t('billing.dialog.wechatQrFailed')}</p>
        <button type="button" className={dialogActionClasses('secondary')} disabled={retrying} onClick={() => void retry()}>
          {t(retrying ? 'billing.dialog.wechatQrRetrying' : 'billing.dialog.wechatQrRetry')}
        </button>
      </div>
    );
  }
  return <img className="mx-auto h-48 w-48 rounded-lg bg-white p-2" src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(qrSvg)}`} alt={t('billing.dialog.wechatQrAlt')} onError={() => setFailed(true)} />;
}
