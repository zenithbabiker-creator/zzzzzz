import React, { useMemo, useState } from 'react';
import { Download, MapPin, Search } from 'lucide-react';
import type { TranslationDictionary } from '../i18n/translations';
import type { Employee, Language, LocationRecord } from '../types/tracking';

interface LocalRecordsViewProps {
  t: TranslationDictionary;
  language: Language;
  employee: Employee;
  activeSessionId: string | null;
  records: LocationRecord[];
}

export const LocalRecordsView: React.FC<LocalRecordsViewProps> = ({
  t,
  language,
  employee,
  activeSessionId,
  records,
}) => {
  const [searchQuery, setSearchQuery] = useState('');
  const [sessionFilter, setSessionFilter] = useState<'all' | 'current'>('all');

  const filteredRecords = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return records.filter((rec) => {
      if (sessionFilter === 'current' && activeSessionId && rec.sessionId !== activeSessionId) {
        return false;
      }
      if (!q) return true;
      return (
        rec.dateStr.toLowerCase().includes(q) ||
        rec.recordId.toLowerCase().includes(q) ||
        rec.provider.toLowerCase().includes(q) ||
        rec.syncStatus.toLowerCase().includes(q)
      );
    });
  }, [records, searchQuery, sessionFilter, activeSessionId]);

  const visibleSlice = useMemo(() => filteredRecords.slice(0, 100), [filteredRecords]);

  const handleExportJson = () => {
    const blob = new Blob([JSON.stringify(filteredRecords, null, 2)], {
      type: 'application/json',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${employee.employeeId}_local_gps_records.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleExportCsv = () => {
    const header = [
      'recordId',
      'sessionId',
      'employeeId',
      'deviceId',
      'latitude',
      'longitude',
      'capturedAtIso',
      'dateStr',
      'hour',
      'minute',
      'second',
      'accuracyMeters',
      'provider',
      'batteryPercent',
      'syncStatus',
      'serverSyncedAt',
    ];
    const rows = filteredRecords.map((r) =>
      [
        r.recordId,
        r.sessionId,
        r.employeeId,
        r.deviceId,
        r.latitude,
        r.longitude,
        r.capturedAtIso,
        r.dateStr,
        r.hour,
        r.minute,
        r.second,
        r.accuracyMeters,
        r.provider,
        r.batteryPercent ?? '',
        r.syncStatus,
        r.serverSyncedAt ?? '',
      ].join(',')
    );
    const csvContent = [header.join(','), ...rows].join('\n');
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${employee.employeeId}_local_gps_records.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const employeeName = language === 'ar' ? employee.fullNameAr : employee.fullNameEn;

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 rounded-2xl border border-[#E2E6DF] bg-white p-5 sm:flex-row sm:items-center sm:justify-between sm:p-6">
        <div>
          <h2 className="text-xl font-bold text-[#111814]">{t.recordsTitle}</h2>
          <p className="mt-1 text-sm text-[#4B554E]">
            <span className="font-mono font-medium text-[#111814]">{employee.employeeId}</span>
            <span className="mx-2" aria-hidden="true">·</span>
            <span>{employeeName}</span>
            <span className="mx-2" aria-hidden="true">·</span>
            <span className="font-mono tabular-nums">{filteredRecords.length}</span>
          </p>
          <p className="mt-1 text-xs text-[#6B756E]">{t.recordsSubtitle}</p>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={handleExportCsv}
            disabled={filteredRecords.length === 0}
            className="inline-flex min-h-[44px] items-center gap-2 rounded-xl border border-[#D4DAD0] bg-white px-4 py-2 text-sm font-medium text-[#111814] transition-colors hover:bg-[#F6F7F4] disabled:opacity-50 whitespace-nowrap shrink-0"
          >
            <Download className="h-4 w-4" />
            <span>{t.exportCsv}</span>
          </button>
          <button
            type="button"
            onClick={handleExportJson}
            disabled={filteredRecords.length === 0}
            className="inline-flex min-h-[44px] items-center gap-2 rounded-xl bg-[#15803D] px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-[#166534] disabled:opacity-50 whitespace-nowrap shrink-0"
          >
            <Download className="h-4 w-4" />
            <span>{t.exportJson}</span>
          </button>
        </div>
      </div>

      <div className="rounded-2xl border border-[#E2E6DF] bg-white">
        <div className="flex flex-col gap-3 border-b border-[#E2E6DF] p-4 sm:flex-row sm:items-center sm:justify-between sm:px-6">
          <div className="relative flex-1 sm:max-w-md">
            <Search className="pointer-events-none absolute top-3.5 start-3.5 h-4 w-4 text-[#6B756E]" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder={t.searchRecordsPlaceholder}
              className="w-full min-h-[44px] rounded-xl border border-[#D4DAD0] bg-[#FAFBF9] ps-10 pe-3.5 text-sm text-[#111814] focus:border-[#15803D] focus:outline-none"
            />
          </div>

          <div className="flex items-center gap-1 rounded-xl bg-[#F1F3EE] p-1">
            <button
              type="button"
              onClick={() => setSessionFilter('all')}
              className={`min-h-[38px] rounded-lg px-3.5 text-xs font-semibold transition-colors whitespace-nowrap shrink-0 ${
                sessionFilter === 'all'
                  ? 'bg-white text-[#111814] shadow-xs'
                  : 'text-[#4B554E] hover:text-[#111814]'
              }`}
            >
              {t.filterAllSessions}
            </button>
            <button
              type="button"
              disabled={!activeSessionId}
              onClick={() => setSessionFilter('current')}
              className={`min-h-[38px] rounded-lg px-3.5 text-xs font-semibold transition-colors whitespace-nowrap shrink-0 disabled:opacity-40 ${
                sessionFilter === 'current'
                  ? 'bg-white text-[#111814] shadow-xs'
                  : 'text-[#4B554E] hover:text-[#111814]'
              }`}
            >
              {t.filterCurrentSession}
            </button>
          </div>
        </div>

        {filteredRecords.length === 0 ? (
          <div className="flex flex-col items-center justify-center px-6 py-16 text-center">
            <MapPin className="h-8 w-8 text-[#6B756E]" />
            <h3 className="mt-3 text-base font-semibold text-[#111814]">{t.noRecordsTitle}</h3>
            <p className="mt-1 max-w-md text-sm text-[#4B554E]">{t.noRecordsBody}</p>
          </div>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-start text-sm">
                <thead>
                  <tr className="border-b border-[#E2E6DF] bg-[#FAFBF9] text-xs font-semibold text-[#4B554E]">
                    <th className="px-4 py-3 text-start">{t.colRecordId}</th>
                    <th className="px-4 py-3 text-start">{t.colTimestamp}</th>
                    <th className="px-4 py-3 text-start">{t.colServerTimestamp}</th>
                    <th className="px-4 py-3 text-start">{t.colCoordinates}</th>
                    <th className="px-4 py-3 text-end">{t.colAccuracy}</th>
                    <th className="px-4 py-3 text-end">{t.colBattery}</th>
                    <th className="px-4 py-3 text-start">{t.colSyncStatus}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#EEF1EB]">
                  {visibleSlice.map((rec) => {
                    const timeStr = `${String(rec.hour).padStart(2, '0')}:${String(rec.minute).padStart(2, '0')}:${String(rec.second).padStart(2, '0')}`;
                    const statusStr = rec.syncStatus as string;
                    const syncColor =
                      statusStr === 'SYNCED'
                        ? 'text-[#15803D]'
                        : statusStr === 'PERMANENT_FAILED' ||
                            statusStr === 'BLOCKED_AUTH' ||
                            statusStr === 'BLOCKED_CONFIGURATION'
                        ? 'text-[#DC2626]'
                        : statusStr === 'RETRYABLE_FAILED' || statusStr === 'FAILED'
                        ? 'text-[#D97706]'
                        : 'text-[#B45309]';
                    const syncLabel =
                      statusStr === 'SYNCED'
                        ? t.syncedSyncValue
                        : statusStr === 'PERMANENT_FAILED'
                        ? t.permanentFailedSyncValue
                        : statusStr === 'BLOCKED_AUTH'
                        ? 'BLOCKED_AUTH'
                        : statusStr === 'BLOCKED_CONFIGURATION'
                        ? 'BLOCKED_CONFIGURATION'
                        : statusStr === 'RETRYABLE_FAILED' || statusStr === 'FAILED'
                        ? t.failedSyncValue
                        : t.pendingSyncValue;
                    const serverTimeDisplay = rec.serverSyncedAt
                      ? rec.serverSyncedAt.replace('T', ' ').slice(0, 19)
                      : '—';

                    return (
                      <tr key={rec.recordId} className="hover:bg-[#FAFBF9]">
                        <td className="px-4 py-3 font-mono text-xs text-[#4B554E]" dir="ltr">
                          {rec.recordId.slice(0, 13)}…
                        </td>
                        <td className="px-4 py-3 font-mono text-xs text-[#111814]" dir="ltr">
                          {rec.dateStr} {timeStr}
                        </td>
                        <td className="px-4 py-3 font-mono text-xs text-[#4B554E]" dir="ltr">
                          {serverTimeDisplay}
                        </td>
                        <td className="px-4 py-3 font-mono text-xs text-[#111814]" dir="ltr">
                          {rec.latitude.toFixed(6)}, {rec.longitude.toFixed(6)}
                        </td>
                        <td className="px-4 py-3 text-end font-mono text-xs text-[#111814]" dir="ltr">
                          {rec.accuracyMeters.toFixed(1)} m
                        </td>
                        <td className="px-4 py-3 text-end font-mono text-xs text-[#111814]" dir="ltr">
                          {rec.batteryPercent !== null ? `${rec.batteryPercent}%` : '—'}
                        </td>
                        <td className={`px-4 py-3 text-xs font-semibold ${syncColor}`}>
                          {syncLabel}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {filteredRecords.length > 100 && (
              <div className="border-t border-[#E2E6DF] bg-[#FAFBF9] px-6 py-3 text-xs text-[#4B554E]">
                {t.showingLatestNote} ({filteredRecords.length})
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
};
