import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "ai.xsayatrade.app"
    compileSdk = 35

    defaultConfig {
        val backendUrl = providers.gradleProperty("xsayatradeBackendUrl").orElse("").get()
        val escapedBackendUrl = backendUrl.replace("\\", "\\\\").replace("\"", "\\\"")
        buildConfigField("String", "XSAYATRADE_BACKEND_URL", "\"$escapedBackendUrl\"")
        applicationId = "ai.xsayatrade.app"
        minSdk = 21
        targetSdk = 35
        versionCode = 1
        versionName = "1.0.0"
    }

    buildTypes {
        debug {
            applicationIdSuffix = ".debug"
            versionNameSuffix = "-debug"
        }
        release {
            isMinifyEnabled = false
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
    }

    buildFeatures {
        buildConfig = true
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

kotlin {
    compilerOptions {
        jvmTarget = JvmTarget.fromTarget("17")
    }
}

val syncXsayaTradeWebAssets by tasks.registering(Copy::class) {
    from(rootProject.projectDir.parentFile) {
        include("index.html", "styles.css", "exchange.css", "extra.css", "backend-ui.css", "i18n.css", "i18n.js", "app.js", "manifest.webmanifest", "icon.svg", "xsayatrade-logo-192.png", "xsayatrade-logo-512.png", "sw.js")
    }
    into(layout.projectDirectory.dir("src/main/assets"))
}

tasks.named("preBuild") {
    dependsOn(syncXsayaTradeWebAssets)
}

dependencies {
    implementation("androidx.core:core-ktx:1.15.0")
    implementation("androidx.webkit:webkit:1.12.1")
}
