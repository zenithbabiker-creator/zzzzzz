# ProGuard / R8 rules for AgriTrack Field Employee App
-keepattributes Signature,InnerClasses,EnclosingMethod,*Annotation*
-keep class com.agritrack.field.data.remote.** { *; }
-keepclassmembers class com.agritrack.field.data.remote.** { *; }
-keepclassmembers class * {
    @retrofit2.http.* <methods>;
}
