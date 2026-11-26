plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.ksp)
}

val debugApiUrl: String = (
    providers.gradleProperty("AGRITRACK_DEBUG_API_URL")
        .orElse(providers.environmentVariable("AGRITRACK_DEBUG_API_URL"))
        .orNull
        ?.trim()
        ?.takeIf { it.isNotEmpty() }
        ?: "http://10.0.2.2:3001/"
    ).let { if (it.endsWith("/")) it else "$it/" }

val prodApiUrlRaw: String = (
    providers.gradleProperty("AGRITRACK_PROD_API_URL")
        .orElse(providers.environmentVariable("AGRITRACK_PROD_API_URL"))
        .orNull
        ?.trim()
        ?: ""
    )
val prodApiUrl: String = if (prodApiUrlRaw.isEmpty() || prodApiUrlRaw.endsWith("/")) {
    prodApiUrlRaw
} else {
    "$prodApiUrlRaw/"
}

android {
    namespace = "com.agritrack.field"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.agritrack.field"
        minSdk = 26
        targetSdk = 35
        versionCode = 1
        versionName = "1.0.0"
    }

    buildTypes {
        debug {
            buildConfigField("String", "API_BASE_URL", "\"$debugApiUrl\"")
        }
        release {
            isMinifyEnabled = true
            buildConfigField("String", "API_BASE_URL", "\"$prodApiUrl\"")
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro"
            )
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    buildFeatures {
        compose = true
        buildConfig = true
    }
}

dependencies {
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.lifecycle.runtime.ktx)
    implementation(libs.androidx.activity.compose)
    implementation(platform(libs.androidx.compose.bom))
    implementation(libs.androidx.ui)
    implementation(libs.androidx.ui.tooling.preview)
    implementation(libs.androidx.material3)

    implementation(libs.androidx.room.runtime)
    implementation(libs.androidx.room.ktx)
    ksp(libs.androidx.room.compiler)

    implementation(libs.androidx.work.runtime.ktx)
    implementation(libs.retrofit.core)
    implementation(libs.retrofit.gson)
    implementation(libs.okhttp.logging)
    implementation(libs.play.services.location)
    implementation(libs.kotlinx.coroutines.android)
    implementation(libs.kotlinx.coroutines.play.services)
    implementation(libs.androidx.security.crypto)
}

gradle.taskGraph.whenReady {
    val hasReleaseTask = allTasks.any { task ->
        task.project == project && task.name.contains("Release", ignoreCase = false)
    }
    if (hasReleaseTask) {
        val invalid = prodApiUrl.isBlank() ||
            !prodApiUrl.startsWith("https://") ||
            prodApiUrl.contains(".example", ignoreCase = true) ||
            prodApiUrl.contains("localhost", ignoreCase = true) ||
            prodApiUrl.contains("127.0.0.1") ||
            prodApiUrl.contains("10.0.2.2")
        if (invalid) {
            throw GradleException(
                "Release builds require a valid HTTPS AGRITRACK_PROD_API_URL (e.g. -PAGRITRACK_PROD_API_URL=https://api.yourdomain.com/)."
            )
        }
    }
}
