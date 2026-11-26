import React, { useState } from 'react';
import { Download } from 'lucide-react';
import { usePWAInstall } from '../hooks/usePWAInstall';
import type { TranslationDictionary } from '../i18n/translations';

interface PWAInstallButtonProps {
  t: TranslationDictionary;
}

export const PWAInstallButton: React.FC<PWAInstallButtonProps> = ({ t }) => {
  const { isInstallable, isInstalled, isIOS, install } = usePWAInstall();
  const [showIOSGuide, setShowIOSGuide] = useState(false);

  if (isInstalled) {
    return null;
  }

  if (isInstallable) {
    return (
      <button
        type="button"
        onClick={install}
        className="inline-flex min-h-[44px] items-center gap-2 rounded-xl border border-[#15803D] bg-[#15803D]/10 px-4 py-2 text-sm font-semibold text-[#15803D] transition-colors hover:bg-[#15803D]/15 whitespace-nowrap shrink-0"
      >
        <Download className="h-4 w-4 shrink-0" />
        <span>{t.installApp}</span>
      </button>
    );
  }

  if (isIOS) {
    return (
      <>
        <button
          type="button"
          onClick={() => setShowIOSGuide(true)}
          className="inline-flex min-h-[44px] items-center gap-2 rounded-xl border border-[#D4DAD0] bg-white px-4 py-2 text-sm font-medium text-[#111814] transition-colors hover:bg-[#F1F3EE] whitespace-nowrap shrink-0"
        >
          <Download className="h-4 w-4 shrink-0" />
          <span>{t.installApp}</span>
        </button>

        {showIOSGuide && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-xs">
            <div className="w-full max-w-sm rounded-2xl border border-[#E2E6DF] bg-white p-6">
              <h3 className="text-lg font-semibold text-[#111814]">{t.installIosTitle}</h3>
              <ol className="mt-3 space-y-2 text-sm text-[#4B554E]">
                <li>1. {t.installIosStep1}</li>
                <li>2. {t.installIosStep2}</li>
              </ol>
              <button
                type="button"
                onClick={() => setShowIOSGuide(false)}
                className="mt-5 w-full min-h-[44px] rounded-xl bg-[#15803D] px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-[#166534]"
              >
                {t.close}
              </button>
            </div>
          </div>
        )}
      </>
    );
  }

  return null;
};
