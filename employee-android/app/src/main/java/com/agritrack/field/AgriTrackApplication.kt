package com.agritrack.field

import android.app.Application
import androidx.work.Configuration

class AgriTrackApplication : Application(), Configuration.Provider {
    override val workManagerConfiguration: Configuration
        get() = Configuration.Builder()
            .setMinimumLoggingLevel(android.util.Log.INFO)
            .build()
}
