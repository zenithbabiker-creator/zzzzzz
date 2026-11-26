import type { Language } from '../types/tracking';

export interface TranslationDictionary {
  brandName: string;
  navTracker: string;
  navRecords: string;
  navRoster: string;
  navAndroid: string;
  phaseBadgeText: string;
  langToggleLabel: string;
  installApp: string;
  installIosTitle: string;
  installIosStep1: string;
  installIosStep2: string;
  close: string;

  // Auth / Sign-in
  signInTitle: string;
  signInSubtitle: string;
  employeeIdLabel: string;
  passcodeLabel: string;
  passcodeHint: string;
  signInButton: string;
  quickSelectLabel: string;
  signOut: string;
  accountInactiveError: string;
  invalidCredentialsError: string;
  employeeNotFoundError: string;

  // Connectivity & Foreground Banner
  onlineMode: string;
  offlineMode: string;
  simOfflineToggle: string;
  simOfflineActive: string;
  foregroundBannerTitle: string;
  foregroundBannerDesc: string;

  // Tracker Console
  fieldHandsetTitle: string;
  employeeLabel: string;
  deviceLabel: string;
  statusLabel: string;
  statusActive: string;
  statusInactive: string;
  sessionIdle: string;
  sessionTracking: string;
  startSession: string;
  stopSession: string;
  captureNow: string;
  nextCaptureIn: string;
  intervalLabel: string;
  intervalValue: string;
  sessionDuration: string;
  recordsThisSession: string;
  totalLocalPending: string;
  latestFixTitle: string;
  noFixYet: string;
  latitudeLabel: string;
  longitudeLabel: string;
  accuracyLabel: string;
  providerLabel: string;
  batteryLabel: string;
  capturedTimeLabel: string;
  syncStatusLabel: string;
  pendingSyncValue: string;
  syncedSyncValue: string;
  failedSyncValue: string;
  permanentFailedSyncValue: string;

  // Phase 2 Synchronization Engine
  syncEngineTitle: string;
  syncEngineSubtitle: string;
  syncNowButton: string;
  syncingLabel: string;
  syncBatchProgress: string;
  syncedCountLabel: string;
  failedCountLabel: string;
  permanentFailedCountLabel: string;
  lastSyncedAtLabel: string;
  neverSynced: string;
  autoSyncEnabledNote: string;
  retryScheduledNote: string;
  syncErrorLabel: string;

  // Phase 2 Test Suite
  phase2SuiteTitle: string;
  phase2SuiteSubtitle: string;
  runPhase2SuiteButton: string;
  runningPhase2Suite: string;
  sim1DayButton: string;
  sim7DaysButton: string;
  sim30DaysButton: string;
  simRunning: string;
  simResultLabel: string;
  duplicatesLabel: string;
  verifyZeroDupes: string;
  suiteSummaryPassed: string;
  suiteSummaryFailed: string;

  // Permission Modal
  permModalTitle: string;
  permModalBody: string;
  permModalPrivacy: string;
  permGrantButton: string;
  permCancelButton: string;

  // Acceptance Checklist
  acceptanceTitle: string;
  accept1: string;
  accept2: string;
  accept3: string;
  accept4: string;
  accept5: string;
  accept10: string;
  accept11: string;
  passedText: string;
  readyText: string;

  // Local Records View
  recordsTitle: string;
  recordsSubtitle: string;
  exportJson: string;
  exportCsv: string;
  filterAllSessions: string;
  filterCurrentSession: string;
  searchRecordsPlaceholder: string;
  colRecordId: string;
  colTimestamp: string;
  colServerTimestamp: string;
  colCoordinates: string;
  colAccuracy: string;
  colProvider: string;
  colBattery: string;
  colSyncStatus: string;
  noRecordsTitle: string;
  noRecordsBody: string;
  showingLatestNote: string;

  // Roster Management
  rosterTitle: string;
  rosterSubtitle: string;
  addEmployee: string;
  searchRosterPlaceholder: string;
  filterAll: string;
  filterActive: string;
  filterInactive: string;
  colEmpId: string;
  colFullName: string;
  colEmpNumber: string;
  colDeviceId: string;
  colAccountStatus: string;
  colSessionState: string;
  colActions: string;
  editEmployee: string;
  disableAccount: string;
  enableAccount: string;
  switchToEmployee: string;
  modalSave: string;
  modalCancel: string;
  fullNameEnLabel: string;
  fullNameArLabel: string;
  empNumberLabel: string;
  deviceIdLabel: string;
  newPasscodeLabel: string;

  // Android Kotlin Source View
  androidTitle: string;
  androidSubtitle: string;
  androidBoundaryTitle: string;
  androidBoundaryBody: string;
  phaseFilterAll: string;
  phaseFilter1: string;
  phaseFilter2: string;
  copyCode: string;
  copied: string;
  downloadAllKotlin: string;

  // Toasts
  toastSessionStarted: string;
  toastSessionStopped: string;
  toastRecordSaved: string;
  toastEmployeeSaved: string;
  toastOfflineSimComplete: string;
  toastSyncSuccess: string;
  toastSyncFailed: string;
  toastPermissionDeniedFallback: string;
}

export const translations: Record<Language, TranslationDictionary> = {
  en: {
    brandName: 'AgriTrack Field',
    navTracker: 'Tracker',
    navRecords: 'Local Records',
    navRoster: 'Employee Roster',
    navAndroid: 'Android Source',
    phaseBadgeText: 'Phase 2 · Offline-First GPS & Automatic Batch Sync',
    langToggleLabel: 'العربية',
    installApp: 'Install App',
    installIosTitle: 'Install on iPhone or iPad',
    installIosStep1: 'Tap the Share icon in your Safari toolbar.',
    installIosStep2: 'Scroll down and select Add to Home Screen.',
    close: 'Close',

    signInTitle: 'Field Employee Sign-In',
    signInSubtitle: 'Authenticate with your assigned Employee ID to access your personal tracking session, local GPS database, and automatic sync queue.',
    employeeIdLabel: 'Employee ID or Number',
    passcodeLabel: 'Passcode',
    passcodeHint: 'Demo employee passcode: 2026',
    signInButton: 'Sign In to Field Terminal',
    quickSelectLabel: 'Quick-select from dynamic registry (50 employees)',
    signOut: 'Sign Out',
    accountInactiveError: 'This employee account is currently inactive. Contact your supervisor to reactivate access.',
    invalidCredentialsError: 'Incorrect passcode. Please verify your field passcode and try again.',
    employeeNotFoundError: 'Employee ID or number not found in the local registry.',

    onlineMode: 'Network Online',
    offlineMode: 'Offline Mode — Saving Locally',
    simOfflineToggle: 'Simulate Offline Mode',
    simOfflineActive: 'Simulated Offline Active',
    foregroundBannerTitle: 'Foreground GPS Service Active',
    foregroundBannerDesc: 'Transparent work-session tracking is running. Locations save locally every 10 minutes and sync automatically when online.',

    fieldHandsetTitle: 'Field Tracking Session',
    employeeLabel: 'Employee',
    deviceLabel: 'Assigned Device',
    statusLabel: 'Account Status',
    statusActive: 'Active',
    statusInactive: 'Inactive',
    sessionIdle: 'Session Idle',
    sessionTracking: 'Tracking Active',
    startSession: 'Start Tracking Session',
    stopSession: 'Stop Tracking Session',
    captureNow: 'Capture GPS Fix Now',
    nextCaptureIn: 'Next 10-min capture',
    intervalLabel: 'Capture Cadence',
    intervalValue: 'Every 10 min',
    sessionDuration: 'Session Elapsed',
    recordsThisSession: 'Session Captures',
    totalLocalPending: 'Pending Records',
    latestFixTitle: 'Latest Locally Stored Coordinate',
    noFixYet: 'No GPS coordinates captured in this session yet. Start a tracking session to record your first fix.',
    latitudeLabel: 'Latitude',
    longitudeLabel: 'Longitude',
    accuracyLabel: 'Accuracy',
    providerLabel: 'Provider',
    batteryLabel: 'Battery',
    capturedTimeLabel: 'Capture Time (YYYY-MM-DD HH:MM:SS)',
    syncStatusLabel: 'Local Sync State',
    pendingSyncValue: 'PENDING (Local)',
    syncedSyncValue: 'SYNCED (Confirmed)',
    failedSyncValue: 'RETRYABLE (Queued)',
    permanentFailedSyncValue: 'REJECTED (Preserved)',

    syncEngineTitle: 'Automatic Synchronization Status',
    syncEngineSubtitle: 'Uploads pending batches (100 records/batch) with UUID idempotency and exponential backoff. Local records are never marked synced before server ACK.',
    syncNowButton: 'Sync Pending Now',
    syncingLabel: 'Synchronizing…',
    syncBatchProgress: 'Uploading batch',
    syncedCountLabel: 'Synchronized',
    failedCountLabel: 'Retry Queued',
    permanentFailedCountLabel: 'rejected (preserved)',
    lastSyncedAtLabel: 'Last Successful Sync',
    neverSynced: 'Not synced yet',
    autoSyncEnabledNote: 'Auto-sync triggers automatically when network connectivity returns.',
    retryScheduledNote: 'Exponential backoff retry in',
    syncErrorLabel: 'Last Sync Notice',

    phase2SuiteTitle: 'Phase 2 Sync & Offline Resilience Verification',
    phase2SuiteSubtitle: 'Execute real IndexedDB + Express /api/sync/batch tests for 1/7/30-day offline queues, interrupted batches, duplicate UUIDs, 503 retries, and employee isolation.',
    runPhase2SuiteButton: 'Run Full Phase 2 Verification Suite',
    runningPhase2Suite: 'Running Phase 2 Tests…',
    sim1DayButton: 'Simulate 1 Day Offline (48)',
    sim7DaysButton: 'Simulate 7 Days Offline (336)',
    sim30DaysButton: 'Simulate 30 Days Offline (1,440)',
    simRunning: 'Writing offline records transactionally…',
    simResultLabel: 'Last Offline Dataset',
    duplicatesLabel: 'Duplicate IDs Detected',
    verifyZeroDupes: 'Verify Zero Duplicates',
    suiteSummaryPassed: 'All Phase 2 verification checks passed',
    suiteSummaryFailed: 'One or more verification checks failed',

    permModalTitle: 'Authorize Location Capture',
    permModalBody: 'AgriTrack Field records your GPS coordinates every 10 minutes strictly while your work tracking session is active.',
    permModalPrivacy: 'No covert tracking occurs. Stopping your session halts all location collection immediately.',
    permGrantButton: 'Authorize & Start Session',
    permCancelButton: 'Cancel',

    acceptanceTitle: 'Phase 1 & 2 Acceptance Checklist',
    accept1: 'Employee opens app and starts authorized tracking session',
    accept2: 'GPS coordinates scheduled every 10 minutes with timestamp & metadata',
    accept3: 'Offline mode toggle & network loss detection active',
    accept4: 'Location records continue saving locally while offline',
    accept5: '30-day offline dataset simulated & persisted across restarts',
    accept10: 'Ending tracking session halts further location collection',
    accept11: 'Dynamic registry supports 50+ employees without code changes',
    passedText: 'Verified',
    readyText: 'Ready',

    recordsTitle: 'Local Offline Database (IndexedDB / Room Equivalent)',
    recordsSubtitle: 'Scoped strictly to the signed-in employee. Preserves device capture time and server receipt time without deleting local records.',
    exportJson: 'Export JSON',
    exportCsv: 'Export CSV',
    filterAllSessions: 'All My Sessions',
    filterCurrentSession: 'Current Session',
    searchRecordsPlaceholder: 'Filter by date (YYYY-MM-DD), status, or record ID...',
    colRecordId: 'Record UUID',
    colTimestamp: 'Device Capture Time',
    colServerTimestamp: 'Server Receipt Time',
    colCoordinates: 'Lat / Lng',
    colAccuracy: 'Accuracy',
    colProvider: 'Provider',
    colBattery: 'Battery',
    colSyncStatus: 'Sync State',
    noRecordsTitle: 'No Local GPS Records Found',
    noRecordsBody: 'Start an authorized tracking session or run an offline simulation to populate local records.',
    showingLatestNote: 'Showing latest 100 matching records for crisp scrolling. Export CSV/JSON for the complete dataset.',

    rosterTitle: 'Dynamic Employee & Device Registry',
    rosterSubtitle: 'Manage 50+ field employees, device assignments, and account access dynamically without modifying application source code.',
    addEmployee: 'Add Employee',
    searchRosterPlaceholder: 'Search by ID (EMP-001), name, or device...',
    filterAll: 'All',
    filterActive: 'Active',
    filterInactive: 'Inactive',
    colEmpId: 'Employee ID',
    colFullName: 'Full Name',
    colEmpNumber: 'Emp. Number',
    colDeviceId: 'Device ID',
    colAccountStatus: 'Status',
    colSessionState: 'Session',
    colActions: 'Actions',
    editEmployee: 'Edit',
    disableAccount: 'Disable',
    enableAccount: 'Enable',
    switchToEmployee: 'Sign In As',
    modalSave: 'Save Employee',
    modalCancel: 'Cancel',
    fullNameEnLabel: 'Full Name (English)',
    fullNameArLabel: 'Full Name (Arabic)',
    empNumberLabel: 'Employee Number',
    deviceIdLabel: 'Assigned Device ID',
    newPasscodeLabel: 'Passcode (leave blank to keep current)',

    androidTitle: 'Native Android Source (Phase 1 & Phase 2 Kotlin)',
    androidSubtitle: 'Production-structured Kotlin modules for Android Studio: Room SQLite, Foreground Service, Jetpack Compose, and WorkManager SyncWorker.',
    androidBoundaryTitle: 'PWA Prototype vs. Native Android Implementation Boundary',
    androidBoundaryBody: 'The live interactive tabs in this browser preview run on PWA IndexedDB + Express HTTP batch sync. The Kotlin files below are the native Android implementation (Room SQLite, Foreground Service, Retrofit, and WorkManager) designed to compile in Android Studio.',
    phaseFilterAll: 'All Phases',
    phaseFilter1: 'Phase 1',
    phaseFilter2: 'Phase 2',
    copyCode: 'Copy File',
    copied: 'Copied',
    downloadAllKotlin: 'Download Kotlin Source Bundle (.json)',

    toastSessionStarted: 'Authorized tracking session started. Initial GPS fix saved locally.',
    toastSessionStopped: 'Tracking session stopped. Location capture halted.',
    toastRecordSaved: 'GPS coordinate committed to local offline database.',
    toastEmployeeSaved: 'Employee registry updated locally.',
    toastOfflineSimComplete: 'Offline dataset written transactionally with zero duplicate UUIDs.',
    toastSyncSuccess: 'Batch synchronization confirmed by server.',
    toastSyncFailed: 'Sync upload failed; local records retained and retry scheduled.',
    toastPermissionDeniedFallback: 'Browser GPS unavailable; using agricultural field coordinate simulator.',
  },
  ar: {
    brandName: 'أجري تراك الميداني',
    navTracker: 'التتبع',
    navRecords: 'السجلات المحلية',
    navRoster: 'سجل الموظفين',
    navAndroid: 'كود أندرويد',
    phaseBadgeText: 'المرحلة 2 · تتبع GPS دون إنترنت والمزامنة التلقائية',
    langToggleLabel: 'English',
    installApp: 'تثبيت التطبيق',
    installIosTitle: 'التثبيت على آيفون أو آيباد',
    installIosStep1: 'اضغط على زر المشاركة في شريط متصفح سفاري.',
    installIosStep2: 'مرر للأسفل واختر إضافة إلى الشاشة الرئيسية.',
    close: 'إغلاق',

    signInTitle: 'تسجيل دخول الموظف الميداني',
    signInSubtitle: 'سجل الدخول برقم الموظف المخصص لك للوصول إلى جلسة التتبع وقاعدة البيانات المحلية وطابور المزامنة التلقائية.',
    employeeIdLabel: 'معرف الموظف أو الرقم الوظيفي',
    passcodeLabel: 'رمز الدخول',
    passcodeHint: 'رمز الدخول التجريبي للموظفين: 2026',
    signInButton: 'الدخول إلى وحدة التتبع',
    quickSelectLabel: 'اختيار سريع من السجل الديناميكي (50 موظفاً)',
    signOut: 'تسجيل الخروج',
    accountInactiveError: 'حساب هذا الموظف معطل حالياً. يرجى التواصل مع المشرف لإعادة تفعيله.',
    invalidCredentialsError: 'رمز الدخول غير صحيح. يرجى التحقق والمحاولة مرة أخرى.',
    employeeNotFoundError: 'معرف الموظف غير موجود في السجل المحلي.',

    onlineMode: 'متصل بالشبكة',
    offlineMode: 'وضع عدم الاتصال — الحفظ محلياً',
    simOfflineToggle: 'محاكاة انقطاع الإنترنت',
    simOfflineActive: 'محاكاة عدم الاتصال مفعلة',
    foregroundBannerTitle: 'خدمة تتبع الموقع في المقدمة نشطة',
    foregroundBannerDesc: 'التتبع المصرح به قيد التشغيل بشفافية. يتم حفظ الإحداثيات محلياً كل 10 دقائق ومزامنتها تلقائياً عند توفر الاتصال.',

    fieldHandsetTitle: 'جلسة التتبع الميداني',
    employeeLabel: 'الموظف',
    deviceLabel: 'الجهاز المخصص',
    statusLabel: 'حالة الحساب',
    statusActive: 'نشط',
    statusInactive: 'معطل',
    sessionIdle: 'الجلسة متوقفة',
    sessionTracking: 'التتبع نشط',
    startSession: 'بدء جلسة التتبع',
    stopSession: 'إيقاف جلسة التتبع',
    captureNow: 'التقاط إحداثية الآن',
    nextCaptureIn: 'الالتقاط التالي خلال',
    intervalLabel: 'معدل الالتقاط',
    intervalValue: 'كل 10 دقائق',
    sessionDuration: 'مدة الجلسة',
    recordsThisSession: 'نقاط هذه الجلسة',
    totalLocalPending: 'السجلات المعلقة',
    latestFixTitle: 'أحدث إحداثية محفوظة محلياً',
    noFixYet: 'لم يتم تسجيل أي إحداثيات في هذه الجلسة بعد. ابدأ جلسة التتبع لتسجيل أول نقطة.',
    latitudeLabel: 'خط العرض',
    longitudeLabel: 'خط الطول',
    accuracyLabel: 'الدقة',
    providerLabel: 'المزود',
    batteryLabel: 'البطارية',
    capturedTimeLabel: 'وقت الالتقاط (التاريخ والساعة)',
    syncStatusLabel: 'حالة المزامنة المحلية',
    pendingSyncValue: 'معلق (محلي)',
    syncedSyncValue: 'تمت المزامنة (مؤكد)',
    failedSyncValue: 'مؤجل لإعادة المحاولة',
    permanentFailedSyncValue: 'مرفوض (محفوظ محلياً)',

    syncEngineTitle: 'حالة المزامنة التلقائية',
    syncEngineSubtitle: 'يرفع السجلات في دفعات (100 سجل/دفعة) مع منع التكرار والتأخير الأسيّ. لا يتم تعليم أي سجل كمزامَن قبل تأكيد الخادم الصريح.',
    syncNowButton: 'مزامنة المعلق الآن',
    syncingLabel: 'جاري المزامنة…',
    syncBatchProgress: 'رفع الدفعة',
    syncedCountLabel: 'متزامنة',
    failedCountLabel: 'إعادة محاولة',
    permanentFailedCountLabel: 'مرفوضة (محفوظة)',
    lastSyncedAtLabel: 'آخر مزامنة ناجحة',
    neverSynced: 'لم تتم المزامنة بعد',
    autoSyncEnabledNote: 'تعمل المزامنة تلقائياً بمجرد عودة الاتصال بالإنترنت.',
    retryScheduledNote: 'إعادة المحاولة بالتأخير الأسي خلال',
    syncErrorLabel: 'ملاحظة آخر محاولة',

    phase2SuiteTitle: 'اختبارات المرحلة 2 للمزامنة والصمود دون إنترنت',
    phase2SuiteSubtitle: 'تشغيل اختبارات حقيقية عبر IndexedDB وخادم Express لفترات 1 و7 و30 يوماً، انقطاع منتصف الدفعة، التكرار، خطأ 503، وعزل الموظفين.',
    runPhase2SuiteButton: 'تشغيل حزمة اختبارات المرحلة 2 الكاملة',
    runningPhase2Suite: 'جاري تشغيل الاختبارات…',
    sim1DayButton: 'محاكاة يوم واحد (48)',
    sim7DaysButton: 'محاكاة 7 أيام (336)',
    sim30DaysButton: 'محاكاة 30 يوماً (1,440)',
    simRunning: 'جاري كتابة السجلات عبر معاملات قاعدة البيانات…',
    simResultLabel: 'آخر مجموعة محاكاة',
    duplicatesLabel: 'السجلات المكررة المكتشفة',
    verifyZeroDupes: 'فحص عدم التكرار',
    suiteSummaryPassed: 'نجحت جميع فحوصات المرحلة 2',
    suiteSummaryFailed: 'فشل فحص واحد أو أكثر',

    permModalTitle: 'تصريح التقاط الموقع الجغرافي',
    permModalBody: 'يقوم تطبيق أجري تراك بتسجيل موقعك كل 10 دقائق فقط أثناء تفعيل جلسة العمل المصرح بها.',
    permModalPrivacy: 'لا يوجد أي تتبع خفي. إيقاف الجلسة يوقف جمع المواقع فوراً.',
    permGrantButton: 'منح التصريح وبدء الجلسة',
    permCancelButton: 'إلغاء',

    acceptanceTitle: 'قائمة التحقق للمرحلتين 1 و2',
    accept1: 'يفتح الموظف التطبيق ويبدأ جلسة تتبع مصرح بها',
    accept2: 'جدولة التقاط الإحداثيات كل 10 دقائق مع الطابع الزمني والبيانات',
    accept3: 'تفعيل محاكاة انقطاع الإنترنت واكتشاف حالة الشبكة',
    accept4: 'استمرار حفظ المواقع محلياً أثناء انقطاع الإنترنت',
    accept5: 'محاكاة تخزين 30 يوماً دون إنترنت مع البقاء بعد إعادة التشغيل',
    accept10: 'إنهاء جلسة التتبع يوقف أي التقاط إضافي للموقع',
    accept11: 'دعم سجل ديناميكي لأكثر من 50 موظفاً دون تعديل الكود',
    passedText: 'تم التحقق',
    readyText: 'جاهز',

    recordsTitle: 'قاعدة البيانات المحلية دون إنترنت (IndexedDB / Room)',
    recordsSubtitle: 'مقيدة بحساب الموظف المسجل فقط. تحفظ وقت التقاط الجهاز ووقت استلام الخادم دون حذف السجلات المحلية.',
    exportJson: 'تصدير JSON',
    exportCsv: 'تصدير CSV',
    filterAllSessions: 'جميع جلساتي',
    filterCurrentSession: 'الجلسة الحالية',
    searchRecordsPlaceholder: 'تصفية بالتاريخ أو الحالة أو المعرف...',
    colRecordId: 'معرف السجل',
    colTimestamp: 'وقت التقاط الجهاز',
    colServerTimestamp: 'وقت استلام الخادم',
    colCoordinates: 'الإحداثيات',
    colAccuracy: 'الدقة',
    colProvider: 'المزود',
    colBattery: 'البطارية',
    colSyncStatus: 'المزامنة',
    noRecordsTitle: 'لا توجد سجلات GPS محلية',
    noRecordsBody: 'ابدأ جلسة تتبع مصرح بها أو شغل اختبار المحاكاة لإنشاء سجلات محلية.',
    showingLatestNote: 'عرض أحدث 100 سجل مطابق للأداء السريع. قم بتصدير CSV أو JSON للحصول على السجل الكامل.',

    rosterTitle: 'السجل الديناميكي للموظفين والأجهزة',
    rosterSubtitle: 'إدارة أكثر من 50 موظفاً ميدانياً وتعيين الأجهزة وتفعيل أو تعطيل الحسابات دون تغيير الشيفرة المصدرية.',
    addEmployee: 'إضافة موظف',
    searchRosterPlaceholder: 'ابحث بالمعرف (EMP-001) أو الاسم أو الجهاز...',
    filterAll: 'الكل',
    filterActive: 'نشط',
    filterInactive: 'معطل',
    colEmpId: 'معرف الموظف',
    colFullName: 'الاسم الكامل',
    colEmpNumber: 'الرقم الوظيفي',
    colDeviceId: 'معرف الجهاز',
    colAccountStatus: 'الحالة',
    colSessionState: 'الجلسة',
    colActions: 'إجراءات',
    editEmployee: 'تعديل',
    disableAccount: 'تعطيل',
    enableAccount: 'تفعيل',
    switchToEmployee: 'دخول كـ',
    modalSave: 'حفظ الموظف',
    modalCancel: 'إلغاء',
    fullNameEnLabel: 'الاسم الكامل (بالإنجليزية)',
    fullNameArLabel: 'الاسم الكامل (بالعربية)',
    empNumberLabel: 'الرقم الوظيفي',
    deviceIdLabel: 'معرف الجهاز المخصص',
    newPasscodeLabel: 'رمز الدخول (اتركه فارغاً للإبقاء على الحالي)',

    androidTitle: 'كود أندرويد الأصلي (المرحلتان 1 و2 Kotlin)',
    androidSubtitle: 'ملفات Kotlin لبيئة Android Studio تشمل Room SQLite وخدمة التتبع الأمامية وJetpack Compose وWorkManager.',
    androidBoundaryTitle: 'الحد الفاصل بين نموذج الويب PWA وتطبيق أندرويد الأصلي',
    androidBoundaryBody: 'التطبيق التفاعلي الحي في المتصفح يعمل عبر IndexedDB وخادم Express التجريبي. أما ملفات Kotlin أدناه فهي التطبيق الأصلي الفعلي (Room SQLite وForeground Service وWorkManager) للبناء عبر Android Studio.',
    phaseFilterAll: 'كل المراحل',
    phaseFilter1: 'المرحلة 1',
    phaseFilter2: 'المرحلة 2',
    copyCode: 'نسخ الملف',
    copied: 'تم النسخ',
    downloadAllKotlin: 'تنزيل حزمة كود أندرويد (.json)',

    toastSessionStarted: 'تم بدء جلسة التتبع المصرح بها وحفظ أول إحداثية محلياً.',
    toastSessionStopped: 'تم إيقاف جلسة التتبع وإيقاف جمع المواقع.',
    toastRecordSaved: 'تم حفظ الإحداثية في قاعدة البيانات المحلية.',
    toastEmployeeSaved: 'تم تحديث سجل الموظف محلياً.',
    toastOfflineSimComplete: 'تم حفظ بيانات عدم الاتصال عبر معاملات قاعدة البيانات دون أي تكرار.',
    toastSyncSuccess: 'تم تأكيد مزامنة الدفعات من الخادم بنجاح.',
    toastSyncFailed: 'فشلت عملية الرفع؛ تم الاحتفاظ بالسجلات محلياً وجدولة إعادة المحاولة.',
    toastPermissionDeniedFallback: 'نظام GPS في المتصفح غير متاح؛ تم استخدام محاكي الإحداثيات الزراعية.',
  },
};
