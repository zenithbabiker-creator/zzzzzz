import React, { useState } from 'react';
import { KeyRound, ShieldCheck, UserCheck } from 'lucide-react';
import type { TranslationDictionary } from '../i18n/translations';
import type { Employee, Language } from '../types/tracking';

interface EmployeeSignInViewProps {
  t: TranslationDictionary;
  language: Language;
  employees: Employee[];
  onSignIn: (identifier: string, passcode: string) => Promise<{ ok: boolean; error?: string }>;
}

export const EmployeeSignInView: React.FC<EmployeeSignInViewProps> = ({
  t,
  language,
  employees,
  onSignIn,
}) => {
  const [identifier, setIdentifier] = useState(employees[0]?.employeeId ?? 'EMP-001');
  const [passcode, setPasscode] = useState('2026');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMessage(null);
    setSubmitting(true);
    try {
      const result = await onSignIn(identifier, passcode);
      if (!result.ok) {
        setErrorMessage(result.error ?? t.invalidCredentialsError);
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="mx-auto grid w-full max-w-5xl grid-cols-1 items-stretch gap-8 py-4 lg:grid-cols-12 lg:py-8">
      <div className="flex flex-col justify-between rounded-2xl border border-[#E2E6DF] bg-white p-6 sm:p-8 lg:col-span-5">
        <div>
          <p className="text-xs font-medium text-[#15803D]">{t.phaseBadgeText}</p>
          <h1 className="mt-3 text-2xl font-bold tracking-tight text-[#111814] sm:text-3xl [text-wrap:balance]">
            {t.signInTitle}
          </h1>
          <p className="mt-3 text-sm leading-relaxed text-[#4B554E]">{t.signInSubtitle}</p>
        </div>

        <div className="mt-8 space-y-4 border-t border-[#E2E6DF] pt-6 text-sm text-[#4B554E]">
          <div className="flex items-start gap-3">
            <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-[#15803D]" />
            <p>{t.permModalPrivacy}</p>
          </div>
          <div className="flex items-start gap-3">
            <UserCheck className="mt-0.5 h-5 w-5 shrink-0 text-[#15803D]" />
            <p>
              {employees.length} · {t.rosterSubtitle}
            </p>
          </div>
        </div>
      </div>

      <form
        onSubmit={handleSubmit}
        className="flex flex-col justify-center rounded-2xl border border-[#E2E6DF] bg-white p-6 sm:p-8 lg:col-span-7"
      >
        <div className="space-y-5">
          <div>
            <label
              htmlFor="quick-emp-select"
              className="block text-sm font-medium text-[#111814]"
            >
              {t.quickSelectLabel}
            </label>
            <select
              id="quick-emp-select"
              value={identifier}
              onChange={(e) => {
                setIdentifier(e.target.value);
                setErrorMessage(null);
              }}
              className="mt-1.5 w-full min-h-[46px] rounded-xl border border-[#D4DAD0] bg-[#FAFBF9] px-3.5 text-sm text-[#111814] focus:border-[#15803D] focus:outline-none"
            >
              {employees.map((emp) => {
                const name = language === 'ar' ? emp.fullNameAr : emp.fullNameEn;
                const statusText = emp.accountStatus === 'active' ? t.statusActive : t.statusInactive;
                return (
                  <option key={emp.employeeId} value={emp.employeeId}>
                    {emp.employeeId} · {name} ({emp.assignedDeviceId}) — {statusText}
                  </option>
                );
              })}
            </select>
          </div>

          <div>
            <label htmlFor="emp-id-input" className="block text-sm font-medium text-[#111814]">
              {t.employeeIdLabel}
            </label>
            <input
              id="emp-id-input"
              type="text"
              dir="ltr"
              required
              value={identifier}
              onChange={(e) => {
                setIdentifier(e.target.value);
                setErrorMessage(null);
              }}
              placeholder="EMP-001"
              className="mt-1.5 w-full min-h-[46px] rounded-xl border border-[#D4DAD0] bg-white px-3.5 font-mono text-sm text-[#111814] focus:border-[#15803D] focus:outline-none"
            />
          </div>

          <div>
            <label htmlFor="emp-passcode-input" className="block text-sm font-medium text-[#111814]">
              {t.passcodeLabel}
            </label>
            <div className="relative mt-1.5">
              <input
                id="emp-passcode-input"
                type="password"
                dir="ltr"
                required
                value={passcode}
                onChange={(e) => {
                  setPasscode(e.target.value);
                  setErrorMessage(null);
                }}
                className="w-full min-h-[46px] rounded-xl border border-[#D4DAD0] bg-white px-3.5 font-mono text-sm text-[#111814] focus:border-[#15803D] focus:outline-none"
              />
              <KeyRound className="pointer-events-none absolute top-3.5 end-3.5 h-4 w-4 text-[#6B756E]" />
            </div>
            <p className="mt-1.5 text-xs text-[#6B756E]">{t.passcodeHint}</p>
          </div>

          {errorMessage && (
            <div
              role="alert"
              className="rounded-xl border border-[#DC2626]/30 bg-[#FEF2F2] px-4 py-3 text-sm font-medium text-[#B91C1C]"
            >
              {errorMessage}
            </div>
          )}

          <button
            type="submit"
            disabled={submitting}
            className="w-full min-h-[48px] rounded-xl bg-[#15803D] px-6 py-3 text-sm font-semibold text-white transition-transform active:scale-[0.99] hover:bg-[#166534] disabled:opacity-60"
          >
            {t.signInButton}
          </button>
        </div>
      </form>
    </div>
  );
};
