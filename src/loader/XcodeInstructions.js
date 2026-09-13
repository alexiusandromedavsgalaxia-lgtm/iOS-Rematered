// src/loader/XcodeInstructions.js
// Referencia completa de Xcode: comandos, build settings, linker flags,
// CLI tools, schemes, workflows, y utilidades.
// Expone un dataset estructurado + motor de búsqueda + render de ayuda.
// Sin dependencias externas.

import { Logger } from '../system/Logger.js';

const LOG_TAG = 'XCODE';

/* ------------------------------------------------------------------ *
 * Categorías
 * ------------------------------------------------------------------ */

export const XCODE_CATEGORY = {
  CLI:                'cli',
  BUILD_SETTING:      'build-setting',
  LINKER_FLAG:        'linker-flag',
  COMPILER_FLAG:      'compiler-flag',
  SWIFT_FLAG:         'swift-flag',
  CLANG_WARNING:      'clang-warning',
  SCHEME:             'scheme',
  WORKFLOW:           'workflow',
  FILE_TYPE:          'file-type',
  SDK:                'sdk',
  DESTINATION:        'destination',
  INSTRUMENT:         'instrument',
  KEYBOARD_SHORTCUT:  'keyboard-shortcut',
  XCCONFIG_KEY:       'xcconfig-key',
  PLIST_KEY:          'plist-key',
  ENV_VAR:            'env-var',
  TEMPLATE:           'template',
};

/* ------------------------------------------------------------------ *
 * 1) Xcode CLI tools (xcodebuild, xcrun, xcode-select, etc.)
 * ------------------------------------------------------------------ */

export const CLI_TOOLS = [
  // --- xcodebuild ---
  { name: 'xcodebuild', usage: 'xcodebuild [options]', cat: 'build', desc: 'Compila, testea, analiza y archiva proyectos Xcode desde línea de comandos.' },
  { name: 'xcodebuild -project', usage: 'xcodebuild -project Foo.xcodeproj', desc: 'Especifica el .xcodeproj a compilar.' },
  { name: 'xcodebuild -workspace', usage: 'xcodebuild -workspace Foo.xcworkspace', desc: 'Especifica el workspace (tiene prioridad sobre -project).' },
  { name: 'xcodebuild -scheme', usage: 'xcodebuild -scheme MyApp', desc: 'Especifica el scheme a construir.' },
  { name: 'xcodebuild -target', usage: 'xcodebuild -target MyTarget', desc: 'Especifica un target (excluyente con -scheme).' },
  { name: 'xcodebuild -configuration', usage: 'xcodebuild -configuration Debug', desc: 'Debug/Release/Custom.' },
  { name: 'xcodebuild -sdk', usage: 'xcodebuild -sdk iphoneos', desc: 'SDK de destino (iphoneos, iphonesimulator, macosx, watchos, appletvos).' },
  { name: 'xcodebuild -destination', usage: 'xcodebuild -destination "platform=iOS Simulator,name=iPhone 16 Pro"', desc: 'Destino de build/test con parámetros platform,name,OS,id,arch.' },
  { name: 'xcodebuild -arch', usage: 'xcodebuild -arch arm64', desc: 'Arquitectura a compilar.' },
  { name: 'xcodebuild -derivedDataPath', usage: 'xcodebuild -derivedDataPath ./build', desc: 'Directorio de DerivedData.' },
  { name: 'xcodebuild -resultBundlePath', usage: 'xcodebuild -resultBundlePath ./Test.xcresult', desc: 'Ruta de salida del resultado de test.' },
  { name: 'xcodebuild -destination-timeout', usage: 'xcodebuild -destination-timeout 60', desc: 'Timeout para encontrar destination.' },
  { name: 'xcodebuild -quiet', usage: 'xcodebuild -quiet', desc: 'Reduce la salida (solo warnings y errores).' },
  { name: 'xcodebuild -verbose', usage: 'xcodebuild -verbose', desc: 'Aumenta la verbosidad.' },
  { name: 'xcodebuild -dry-run', usage: 'xcodebuild -dry-run', desc: 'Muestra los comandos sin ejecutarlos.' },
  { name: 'xcodebuild -showBuildSettings', usage: 'xcodebuild -showBuildSettings', desc: 'Imprime todos los build settings resueltos.' },
  { name: 'xcodebuild -showdestinations', usage: 'xcodebuild -showdestinations -scheme X', desc: 'Lista destinations válidos.' },
  { name: 'xcodebuild -list', usage: 'xcodebuild -list', desc: 'Lista targets, schemes y configurations.' },
  { name: 'xcodebuild -exportArchive', usage: 'xcodebuild -exportArchive -archivePath A.xcarchive -exportPath out', desc: 'Exporta IPA/APP desde un xcarchive.' },
  { name: 'xcodebuild -exportOptionsPlist', usage: 'xcodebuild ... -exportOptionsPlist ExportOptions.plist', desc: 'Opciones de exportación (ad-hoc, app-store, enterprise, development).' },
  { name: 'xcodebuild -allowProvisioningUpdates', usage: 'xcodebuild ... -allowProvisioningUpdates', desc: 'Permite actualizar perfiles/firmas automáticamente.' },
  { name: 'xcodebuild -allowProvisioningDeviceRegistration', usage: 'xcodebuild ... -allowProvisioningDeviceRegistration', desc: 'Registra el dispositivo actual en el portal.' },
  { name: 'xcodebuild -authenticationKeyPath', usage: 'xcodebuild ... -authenticationKeyPath key.p8', desc: 'App Store Connect API key para xcodebuild.' },
  { name: 'xcodebuild -authenticationKeyID', usage: 'xcodebuild ... -authenticationKeyID ABC123', desc: 'Key ID del API key.' },
  { name: 'xcodebuild -authenticationKeyIssuerID', usage: 'xcodebuild ... -authenticationKeyIssuerID uuid', desc: 'Issuer ID del API key.' },
  { name: 'xcodebuild clean', usage: 'xcodebuild clean', desc: 'Limpia el proyecto.' },
  { name: 'xcodebuild build', usage: 'xcodebuild build', desc: 'Compila.' },
  { name: 'xcodebuild test', usage: 'xcodebuild test -scheme X -destination Y', desc: 'Ejecuta tests.' },
  { name: 'xcodebuild test-without-building', usage: 'xcodebuild test-without-building', desc: 'Ejecuta tests sin recompilar.' },
  { name: 'xcodebuild analyze', usage: 'xcodebuild analyze', desc: 'Static analyzer.' },
  { name: 'xcodebuild archive', usage: 'xcodebuild archive -scheme X -archivePath A.xcarchive', desc: 'Crea un archive.' },
  { name: 'xcodebuild install', usage: 'xcodebuild install', desc: 'Instala el build resultante.' },
  { name: 'xcodebuild installsrc', usage: 'xcodebuild installsrc', desc: 'Copia las fuentes a srcroot.' },
  { name: 'xcodebuild installhdrs', usage: 'xcodebuild installhdrs', desc: 'Instala headers.' },
  { name: 'xcodebuild -skipMacroValidation', usage: 'xcodebuild -skipMacroValidation', desc: 'Omite validación de macros de Swift Package.' },
  { name: 'xcodebuild -skipPackagePluginValidation', usage: 'xcodebuild -skipPackagePluginValidation', desc: 'Omite validación de plugins.' },
  { name: 'xcodebuild -resolvePackageDependencies', usage: 'xcodebuild -resolvePackageDependencies', desc: 'Resuelve dependencias SPM.' },
  { name: 'xcodebuild -cloneSourcePackages', usage: 'xcodebuild -cloneSourcePackages', desc: 'Clona source packages.' },
  { name: 'xcodebuild -disableAutomaticPackageResolution', usage: 'xcodebuild -disableAutomaticPackageResolution', desc: 'No resuelve paquetes automáticamente.' },
  { name: 'xcodebuild -onlyUsePackageVersionsFromResolvedFile', usage: 'xcodebuild ... -onlyUsePackageVersionsFromResolvedFile', desc: 'Usa solo Package.resolved.' },

  // --- xcrun ---
  { name: 'xcrun', usage: 'xcrun <tool> [args]', cat: 'cli', desc: 'Ejecuta herramientas de Xcode sin especificar paths.' },
  { name: 'xcrun --sdk', usage: 'xcrun --sdk iphoneos <tool>', desc: 'Fuerza un SDK concreto.' },
  { name: 'xcrun --find', usage: 'xcrun --find swiftc', desc: 'Encuentra la ruta del tool.' },
  { name: 'xcrun --show-sdk-path', usage: 'xcrun --sdk iphoneos --show-sdk-path', desc: 'Muestra la ruta del SDK.' },
  { name: 'xcrun --show-sdk-version', usage: 'xcrun --sdk iphoneos --show-sdk-version', desc: 'Versión del SDK.' },
  { name: 'xcrun --show-sdk-platform-path', usage: 'xcrun --show-sdk-platform-path', desc: 'Path de la platform.' },
  { name: 'xcrun simctl', usage: 'xcrun simctl <subcommand>', desc: 'Controla simuladores iOS.' },
  { name: 'xcrun simctl list', usage: 'xcrun simctl list devices', desc: 'Lista simuladores y runtimes.' },
  { name: 'xcrun simctl boot', usage: 'xcrun simctl boot "iPhone 16 Pro"', desc: 'Arranca un simulador.' },
  { name: 'xcrun simctl bootstatus', usage: 'xcrun simctl bootstatus "iPhone 16 Pro" -b', desc: 'Espera al boot completo.' },
  { name: 'xcrun simctl shutdown', usage: 'xcrun simctl shutdown all', desc: 'Apaga simulador(es).' },
  { name: 'xcrun simctl install', usage: 'xcrun simctl install booted MyApp.app', desc: 'Instala un .app.' },
  { name: 'xcrun simctl launch', usage: 'xcrun simctl launch --console booted com.example.app', desc: 'Ejecuta app en el simulador.' },
  { name: 'xcrun simctl terminate', usage: 'xcrun simctl terminate booted com.example.app', desc: 'Termina la app.' },
  { name: 'xcrun simctl uninstall', usage: 'xcrun simctl uninstall booted com.example.app', desc: 'Desinstala.' },
  { name: 'xcrun simctl openurl', usage: 'xcrun simctl openurl booted https://apple.com', desc: 'Abre una URL.' },
  { name: 'xcrun simctl push', usage: 'xcrun simctl push booted com.example.app payload.apns', desc: 'Envía push simulado.' },
  { name: 'xcrun simctl spawn', usage: 'xcrun simctl spawn booted log stream', desc: 'Ejecuta binario en el simulador.' },
  { name: 'xcrun simctl io', usage: 'xcrun simctl io booted screenshot out.png', desc: 'Captura screenshot o vídeo.' },
  { name: 'xcrun simctl io recordVideo', usage: 'xcrun simctl io booted recordVideo out.mov', desc: 'Graba vídeo.' },
  { name: 'xcrun simctl addmedia', usage: 'xcrun simctl addmedia booted photo.jpg', desc: 'Añade media a Photos.' },
  { name: 'xcrun simctl status_bar', usage: 'xcrun simctl status_bar booted override --time 9:41', desc: 'Override status bar.' },
  { name: 'xcrun simctl get_app_container', usage: 'xcrun simctl get_app_container booted com.example.app data', desc: 'Path del contenedor.' },
  { name: 'xcrun simctl privacy', usage: 'xcrun simctl privacy booted grant photos com.example.app', desc: 'Otorga/revoca permisos TCC.' },
  { name: 'xcrun simctl location', usage: 'xcrun simctl location booted set 40.4,-3.7', desc: 'Set location simulada.' },

  // --- xcode-select ---
  { name: 'xcode-select', usage: 'xcode-select <option>', desc: 'Gestiona la developer directory activa.' },
  { name: 'xcode-select --install', usage: 'xcode-select --install', desc: 'Instala Command Line Tools.' },
  { name: 'xcode-select --switch', usage: 'xcode-select --switch /Applications/Xcode.app', desc: 'Cambia la versión activa.' },
  { name: 'xcode-select --print-path', usage: 'xcode-select --print-path', desc: 'Muestra el path actual.' },
  { name: 'xcode-select --reset', usage: 'xcode-select --reset', desc: 'Restaura la selección por defecto.' },

  // --- xcodebuild-* helpers ---
  { name: 'xcodebuild -create-xcframework', usage: 'xcodebuild -create-xcframework -framework A.framework -output A.xcframework', desc: 'Empaqueta varios slices en xcframework.' },
  { name: 'xcrun xcodebuild -version', usage: 'xcodebuild -version', desc: 'Versión de Xcode activa.' },

  // --- swift CLI ---
  { name: 'swift', usage: 'swift <file.swift>', cat: 'swift', desc: 'REPL/scripting.' },
  { name: 'swiftc', usage: 'swiftc -O main.swift', desc: 'Compila Swift.' },
  { name: 'swift build', usage: 'swift build', desc: 'Compila un Swift Package.' },
  { name: 'swift test', usage: 'swift test', desc: 'Ejecuta tests de un Swift Package.' },
  { name: 'swift run', usage: 'swift run MyExecutable', desc: 'Ejecuta un executable del package.' },
  { name: 'swift package init', usage: 'swift package init --type library', desc: 'Crea un package.' },
  { name: 'swift package resolve', usage: 'swift package resolve', desc: 'Resuelve dependencias.' },
  { name: 'swift package update', usage: 'swift package update', desc: 'Actualiza dependencias.' },
  { name: 'swift package show-dependencies', usage: 'swift package show-dependencies', desc: 'Grafo de dependencias.' },
  { name: 'swift package describe', usage: 'swift package describe', desc: 'JSON del package.' },
  { name: 'swift package generate-xcodeproj', usage: 'swift package generate-xcodeproj', desc: 'Genera .xcodeproj (legacy).' },

  // --- Otros ---
  { name: 'xctest', usage: 'xcrun xctest MyTests.xctest', desc: 'Ejecuta bundle de tests directamente.' },
  { name: 'instruments', usage: 'instruments -w <device> -t "<template>"', desc: 'CLI de Instruments.' },
  { name: 'xctrace', usage: 'xctrace record --template "Time Profiler"', desc: 'Sucesor de instruments CLI.' },
  { name: 'xctrace list', usage: 'xctrace list devices', desc: 'Lista dispositivos.' },
  { name: 'xctrace export', usage: 'xctrace export --input run.trace --xpath ...', desc: 'Exporta datos de un .trace.' },
  { name: 'actool', usage: 'xcrun actool Assets.xcassets', desc: 'Compila catálogos de assets.' },
  { name: 'ibtool', usage: 'xcrun ibtool --compile out.nib in.xib', desc: 'Compila XIB/Storyboard.' },
  { name: 'momc', usage: 'xcrun momc Model.xcdatamodeld out.momd', desc: 'Compila Core Data model.' },
  { name: 'mapc', usage: 'xcrun mapc --compile out --sdk-root . file.map', desc: 'Compila mapas (.map).' },
  { name: 'metal', usage: 'xcrun -sdk iphoneos metal -c shader.metal', desc: 'Compila Metal shaders.' },
  { name: 'metallib', usage: 'xcrun metallib shader.air -o default.metallib', desc: 'Enlaza .metallib.' },
  { name: 'copy-strings', usage: 'xcrun copy-strings -validate en.lproj', desc: 'Valida strings files.' },
  { name: 'plutil', usage: 'plutil -convert binary1 Info.plist', desc: 'Convierte/valida plists.' },
  { name: 'codesign', usage: 'codesign --sign "Apple Development" MyApp.app', desc: 'Firma apps.' },
  { name: 'codesign --verify', usage: 'codesign --verify --deep --strict MyApp.app', desc: 'Verifica firma.' },
  { name: 'codesign --display', usage: 'codesign --display --entitlements - MyApp.app', desc: 'Muestra entitlements.' },
  { name: 'security find-identity', usage: 'security find-identity -v -p codesigning', desc: 'Lista identidades de firma.' },
  { name: 'security cms', usage: 'security cms -D -i profile.mobileprovision', desc: 'Decodifica provisioning profile.' },
  { name: 'notarytool', usage: 'xcrun notarytool submit MyApp.zip --apple-id x', desc: 'Notariza app (macOS).' },
  { name: 'stapler', usage: 'xcrun stapler staple MyApp.app', desc: 'Adjunta notarización.' },
  { name: 'altool', usage: 'xcrun altool --upload-app -f MyApp.ipa -t ios', desc: 'Sube a App Store (legacy).' },
  { name: 'iTMSTransporter', usage: 'xcrun iTMSTransporter -m upload ...', desc: 'Upload masivo (legacy).' },
];

/* ------------------------------------------------------------------ *
 * 2) Build settings
 * ------------------------------------------------------------------ */

export const BUILD_SETTINGS = [
  // --- General ---
  { name: 'PRODUCT_NAME', type: 'string', default: '$(TARGET_NAME)', desc: 'Nombre del producto.' },
  { name: 'PRODUCT_BUNDLE_IDENTIFIER', type: 'string', desc: 'Bundle ID único (com.example.app).' },
  { name: 'PRODUCT_MODULE_NAME', type: 'string', desc: 'Nombre del módulo Swift (identificador).' },
  { name: 'CURRENT_PROJECT_VERSION', type: 'string', default: '1', desc: 'Build number (CFBundleVersion).' },
  { name: 'MARKETING_VERSION', type: 'string', default: '1.0', desc: 'Versión corta (CFBundleShortVersionString).' },
  { name: 'INFOPLIST_FILE', type: 'path', desc: 'Ruta al Info.plist.' },
  { name: 'INFOPLIST_KEY_*', type: 'string', desc: 'Claves inyectadas en Info.plist generado.' },
  { name: 'GENERATE_INFOPLIST_FILE', type: 'bool', default: 'NO', desc: 'Generar Info.plist automáticamente.' },
  { name: 'TARGETED_DEVICE_FAMILY', type: 'enum', default: '1,2', desc: '1=iPhone, 2=iPad, 3=TV, 4=Watch, 6=Vision.' },
  { name: 'SUPPORTED_PLATFORMS', type: 'list', default: 'iphoneos iphonesimulator', desc: 'Platforms soportadas.' },
  { name: 'SUPPORTS_MACCATALYST', type: 'bool', default: 'NO', desc: 'Habilitar Mac Catalyst.' },
  { name: 'SUPPORTS_MAC_DESIGNED_FOR_IPHONE_IPAD', type: 'bool', default: 'YES', desc: 'Correr en Apple Silicon Macs.' },
  { name: 'IPHONEOS_DEPLOYMENT_TARGET', type: 'version', default: '18.0', desc: 'Minimum iOS version.' },
  { name: 'MACOSX_DEPLOYMENT_TARGET', type: 'version', desc: 'Minimum macOS.' },
  { name: 'WATCHOS_DEPLOYMENT_TARGET', type: 'version', desc: 'Minimum watchOS.' },
  { name: 'TVOS_DEPLOYMENT_TARGET', type: 'version', desc: 'Minimum tvOS.' },
  { name: 'VISIONOS_DEPLOYMENT_TARGET', type: 'version', desc: 'Minimum visionOS.' },
  { name: 'SDKROOT', type: 'enum', default: 'iphoneos', desc: 'SDK raíz.' },
  { name: 'ARCHS', type: 'list', default: '$(ARCHS_STANDARD)', desc: 'Arquitecturas.' },
  { name: 'ONLY_ACTIVE_ARCH', type: 'bool', default: 'YES (Debug)', desc: 'Compilar solo la arch activa.' },
  { name: 'EXCLUDED_ARCHS', type: 'list', desc: 'Arquitecturas a excluir.' },
  { name: 'VALID_ARCHS', type: 'list', desc: '(deprecated) Arquitecturas válidas.' },
  { name: 'CONFIGURATION', type: 'string', desc: 'Debug/Release.' },
  { name: 'CONFIGURATION_BUILD_DIR', type: 'path', desc: 'Directorio de salida.' },
  { name: 'BUILD_DIR', type: 'path', desc: 'Directorio de build.' },
  { name: 'DERIVED_FILE_DIR', type: 'path', desc: 'Directorio de archivos derivados.' },
  { name: 'PROJECT_DIR', type: 'path', desc: 'Directorio del proyecto.' },
  { name: 'SRCROOT', type: 'path', desc: 'Raíz de fuentes.' },
  { name: 'PROJECT_NAME', type: 'string', desc: 'Nombre del .xcodeproj.' },
  { name: 'TARGET_NAME', type: 'string', desc: 'Nombre del target.' },
  { name: 'WRAPPER_EXTENSION', type: 'string', default: 'app', desc: 'Extensión del bundle.' },
  { name: 'MACH_O_TYPE', type: 'enum', default: 'mh_execute', desc: 'mh_execute, mh_dylib, mh_bundle, mh_object.' },
  { name: 'EXECUTABLE_PREFIX', type: 'string', desc: 'Prefijo del ejecutable.' },
  { name: 'EXECUTABLE_SUFFIX', type: 'string', desc: 'Sufijo del ejecutable.' },

  // --- Swift ---
  { name: 'SWIFT_VERSION', type: 'enum', default: '5.0', desc: 'Versión del lenguaje Swift (5.0, 5.9, 6.0).' },
  { name: 'SWIFT_OPTIMIZATION_LEVEL', type: 'enum', default: '-Onone (Debug) / -O (Release)', desc: '-Onone, -O, -Osize.' },
  { name: 'SWIFT_COMPILATION_MODE', type: 'enum', default: 'singlefile / wholemodule', desc: 'Modo de compilación.' },
  { name: 'SWIFT_ACTIVE_COMPILATION_CONDITIONS', type: 'list', desc: 'Defines para #if (DEBUG, ...).' },
  { name: 'SWIFT_INCLUDE_PATHS', type: 'list', desc: 'Paths de módulos.' },
  { name: 'SWIFT_OBJC_BRIDGING_HEADER', type: 'path', desc: 'Header puente ObjC↔Swift.' },
  { name: 'SWIFT_OBJC_INTERFACE_HEADER_NAME', type: 'string', desc: 'Nombre del header -Swift.h.' },
  { name: 'SWIFT_OBJC_INTERFACE_HEADER_DIR', type: 'path', desc: 'Directorio del header generado.' },
  { name: 'SWIFT_EMIT_LOC_STRINGS', type: 'bool', default: 'YES', desc: 'Localized strings automáticas.' },
  { name: 'SWIFT_STRICT_CONCURRENCY', type: 'enum', default: 'minimal', desc: 'minimal, targeted, complete.' },
  { name: 'SWIFT_UPCOMING_FEATURE_*', type: 'bool', desc: 'Activa upcoming features (ExistentialAny, etc.).' },
  { name: 'SWIFT_TREAT_WARNINGS_AS_ERRORS', type: 'bool', default: 'NO', desc: 'Warnings como errores.' },
  { name: 'SWIFT_SUPPRESS_WARNINGS', type: 'bool', default: 'NO', desc: 'Suprime warnings.' },
  { name: 'SWIFT_ENABLE_BATCH_MODE', type: 'bool', default: 'YES', desc: 'Compilación batch.' },
  { name: 'SWIFT_USE_INTEGRATED_DRIVER', type: 'bool', default: 'YES', desc: 'Driver integrado.' },
  { name: 'SWIFT_INDEX_STORE_ENABLE', type: 'bool', default: 'YES', desc: 'Index store para IDE.' },
  { name: 'SWIFT_WHOLE_MODULE_OPTIMIZATION', type: 'bool', default: 'NO', desc: 'WMO explícito.' },
  { name: 'SWIFT_REFLECTION_METADATA_LEVEL', type: 'enum', default: 'all', desc: 'all, without-names, none.' },

  // --- Clang / ObjC ---
  { name: 'CLANG_ENABLE_MODULES', type: 'bool', default: 'YES', desc: 'Modules @import.' },
  { name: 'CLANG_ENABLE_OBJC_ARC', type: 'bool', default: 'YES', desc: 'ARC.' },
  { name: 'CLANG_ENABLE_OBJC_WEAK', type: 'bool', default: 'YES', desc: 'Weak refs.' },
  { name: 'CLANG_WARN_*', type: 'bool', desc: 'Conjunto de warnings (ver CLANG_WARNINGS).' },
  { name: 'CLANG_CXX_LANGUAGE_STANDARD', type: 'enum', default: 'gnu++20', desc: 'c++11, c++14, c++17, c++20, gnu++*.' },
  { name: 'CLANG_CXX_LIBRARY', type: 'enum', default: 'libc++', desc: 'libc++ o libstdc++.' },
  { name: 'GCC_C_LANGUAGE_STANDARD', type: 'enum', default: 'gnu17', desc: 'c99, c11, c17, gnu*.' },
  { name: 'GCC_OPTIMIZATION_LEVEL', type: 'enum', default: '0 (Debug) / s (Release)', desc: '0,1,2,3,s,fast.' },
  { name: 'GCC_PREPROCESSOR_DEFINITIONS', type: 'list', desc: 'Defines -D.' },
  { name: 'GCC_PREFIX_HEADER', type: 'path', desc: 'Prefix header ObjC.' },
  { name: 'GCC_PRECOMPILE_PREFIX_HEADER', type: 'bool', default: 'YES', desc: 'Precompilar prefix.' },
  { name: 'GCC_INCREASE_PRECOMPILED_HEADER_SHARING', type: 'bool', desc: 'PCH compartido.' },
  { name: 'GCC_WARN_*', type: 'bool', desc: 'Familia de warnings GCC.' },
  { name: 'GCC_TREAT_WARNINGS_AS_ERRORS', type: 'bool', default: 'NO', desc: 'Warnings como errores.' },
  { name: 'GCC_NO_COMMON_BLOCKS', type: 'bool', default: 'NO', desc: '-fno-common.' },
  { name: 'GCC_SYMBOLS_PRIVATE_EXTERN', type: 'bool', desc: '-fvisibility=hidden.' },

  // --- Compilación ---
  { name: 'ENABLE_STRICT_OBJC_MSGSEND', type: 'bool', default: 'YES', desc: 'objc_msgSend estricto.' },
  { name: 'ENABLE_MODULE_VERIFIER', type: 'bool', default: 'NO', desc: 'Verifica módulos.' },
  { name: 'MODULE_VERIFIER_SUPPORTED_LANGUAGES', type: 'list', desc: 'c c++ objc.' },
  { name: 'CLANG_ANALYZER_*', type: 'varios', desc: 'Opciones del static analyzer.' },
  { name: 'ENABLE_USER_SCRIPT_SANDBOXING', type: 'bool', default: 'YES', desc: 'Sandbox de run scripts.' },
  { name: 'ENABLE_TESTABILITY', type: 'bool', default: 'YES (Debug)', desc: '@testable import.' },
  { name: 'ENABLE_HARDENED_RUNTIME', type: 'bool', default: 'NO (iOS)', desc: 'Hardened runtime (macOS).' },
  { name: 'ENABLE_BITCODE', type: 'bool', default: 'NO', desc: 'Bitcode (deprecated).' },
  { name: 'DEPLOYMENT_POSTPROCESSING', type: 'bool', default: 'NO', desc: 'Strip symbols al archivar.' },
  { name: 'STRIP_INSTALLED_PRODUCT', type: 'bool', default: 'YES (Release)', desc: 'Strip final.' },
  { name: 'COPY_PHASE_STRIP', type: 'bool', default: 'NO', desc: 'Strip durante copy phase.' },
  { name: 'STRIP_STYLE', type: 'enum', default: 'all', desc: 'all, non-global, debugging.' },
  { name: 'DEBUG_INFORMATION_FORMAT', type: 'enum', default: 'dwarf-with-dsym (Release)', desc: 'dwarf, dwarf-with-dsym.' },
  { name: 'DEBUG_INFORMATION_VERSION', type: 'enum', desc: 'dwarf, dwarf4, dwarf5.' },

  // --- Linking ---
  { name: 'OTHER_LDFLAGS', type: 'list', desc: 'Flags adicionales al linker.' },
  { name: 'OTHER_SWIFT_FLAGS', type: 'list', desc: 'Flags adicionales a swiftc.' },
  { name: 'OTHER_CFLAGS', type: 'list', desc: 'Flags adicionales a clang (C).' },
  { name: 'OTHER_CPLUSPLUSFLAGS', type: 'list', desc: 'Flags adicionales a clang (C++).' },
  { name: 'FRAMEWORK_SEARCH_PATHS', type: 'list', desc: 'Paths de frameworks.' },
  { name: 'LIBRARY_SEARCH_PATHS', type: 'list', desc: 'Paths de librerías.' },
  { name: 'HEADER_SEARCH_PATHS', type: 'list', desc: 'Paths de headers.' },
  { name: 'SYSTEM_HEADER_SEARCH_PATHS', type: 'list', desc: 'Paths de headers de sistema.' },
  { name: 'USER_HEADER_SEARCH_PATHS', type: 'list', desc: 'Paths de user headers.' },
  { name: 'ALWAYS_SEARCH_USER_PATHS', type: 'bool', default: 'NO', desc: 'Buscar user paths siempre.' },
  { name: 'LD_RUNPATH_SEARCH_PATHS', type: 'list', default: '@executable_path/Frameworks', desc: 'Runpath de dylibs.' },
  { name: 'LD_DYLIB_INSTALL_NAME', type: 'string', desc: 'install_name de dylibs.' },
  { name: 'LD_GENERATE_MAP_FILE', type: 'bool', default: 'NO', desc: 'Genera .map.' },
  { name: 'OTHER_LDFLAGS', type: 'list', desc: 'Flags al linker.' },
  { name: 'DEAD_CODE_STRIPPING', type: 'bool', default: 'YES', desc: '-dead_strip.' },
  { name: 'PRESERVE_DEAD_CODE_INITS_AND_TERMS', type: 'bool', desc: 'Preservar +load.' },

  // --- Signing ---
  { name: 'CODE_SIGN_IDENTITY', type: 'string', desc: 'Apple Development, Apple Distribution, etc.' },
  { name: 'CODE_SIGN_STYLE', type: 'enum', default: 'Automatic', desc: 'Automatic o Manual.' },
  { name: 'CODE_SIGN_ENTITLEMENTS', type: 'path', desc: 'Entitlements plist.' },
  { name: 'CODE_SIGN_INJECT_BASE_ENTITLEMENTS', type: 'bool', default: 'YES', desc: 'Inyecta get-task-allow en debug.' },
  { name: 'DEVELOPMENT_TEAM', type: 'string', desc: 'Team ID (10 caracteres).' },
  { name: 'PROVISIONING_PROFILE', type: 'uuid', desc: 'UUID del profile (manual).' },
  { name: 'PROVISIONING_PROFILE_SPECIFIER', type: 'string', desc: 'Nombre del profile (manual).' },
  { name: 'CODE_SIGN_RESOURCE_RULES_PATH', type: 'path', desc: 'Reglas de firma de recursos.' },
  { name: 'OTHER_CODE_SIGN_FLAGS', type: 'list', desc: 'Flags adicionales a codesign.' },
  { name: 'ENABLE_APP_SANDBOX', type: 'bool', desc: 'Sandbox (macOS, iOS extensions).' },
  { name: 'ENABLE_POINTER_AUTHENTICATION', type: 'bool', desc: 'arm64e PAC.' },

  // --- Assets / Storyboards ---
  { name: 'ASSETCATALOG_COMPILER_APPICON_NAME', type: 'string', default: 'AppIcon', desc: 'Nombre del AppIcon set.' },
  { name: 'ASSETCATALOG_COMPILER_GLOBAL_ACCENT_COLOR_NAME', type: 'string', desc: 'Accent color.' },
  { name: 'ASSETCATALOG_COMPILER_INCLUDE_ALL_APPICON_ASSETS', type: 'bool', desc: 'Incluir todos los icons.' },
  { name: 'ASSETCATALOG_COMPILER_LAUNCHIMAGE_NAME', type: 'string', desc: 'LaunchImage.' },
  { name: 'ASSETCATALOG_COMPILER_OPTIMIZATION', type: 'enum', desc: 'space, time, none.' },
  { name: 'ASSETCATALOG_COMPILER_SKIP_APP_STORE_DEPLOYMENT', type: 'bool', desc: 'Omite validación App Store.' },
  { name: 'IBSC_MODULE', type: 'string', desc: 'Módulo por defecto para IB.' },
  { name: 'STRINGS_FILE_OUTPUT_ENCODING', type: 'enum', default: 'binary', desc: 'binary o UTF-8.' },
  { name: 'LOCALIZATION_PREFERS_STRING_CATALOGS', type: 'bool', default: 'YES', desc: 'Usa String Catalogs.' },

  // --- Preprocessing ---
  { name: 'APP_SHORTCUTS_ENABLE_FLEXIBLE_MATCHING', type: 'bool', desc: 'Matching flexible de shortcuts.' },
  { name: 'LOCALIZED_STRING_MACRO_NAMES', type: 'list', desc: 'Macros que se traducen.' },

  // --- Testing ---
  { name: 'TEST_HOST', type: 'path', desc: 'Host app para tests.' },
  { name: 'BUNDLE_LOADER', type: 'path', desc: 'Binario para bundle de test.' },
  { name: 'TEST_TARGET_NAME', type: 'string', desc: 'Nombre del target bajo test.' },
  { name: 'TEST_TARGET_NAME_UI', type: 'string', desc: 'Target para UI tests.' },
  { name: 'ENABLE_CODE_COVERAGE', type: 'bool', default: 'NO', desc: 'Cobertura de código.' },
  { name: 'CLANG_ENABLE_CODE_COVERAGE', type: 'bool', desc: 'Cobertura clang.' },
  { name: 'SWIFT_ENABLE_CODE_COVERAGE', type: 'bool', desc: 'Cobertura Swift.' },

  // --- Extensions ---
  { name: 'APPLICATION_EXTENSION_API_ONLY', type: 'bool', default: 'NO', desc: 'Solo APIs de extension.' },
  { name: 'NSEXTENSION_*', type: 'varios', desc: 'Puntos de extensión (NSExtensionPointIdentifier, etc.).' },

  // --- Watch ---
  { name: 'WK_COMPANION_APP_BUNDLE_IDENTIFIER', type: 'string', desc: 'Bundle ID del companion iOS.' },
  { name: 'WK_APP_BUNDLE_IDENTIFIER', type: 'string', desc: 'Bundle ID del watch app.' },
  { name: 'WK_EXTENSION_BUNDLE_IDENTIFIER', type: 'string', desc: 'Bundle ID de la extensión de watch.' },

  // --- Vision ---
  { name: 'VISIONOS_DEPLOYMENT_TARGET', type: 'version', desc: 'Minimum visionOS.' },

  // --- Package Manager ---
  { name: 'SPM_*', type: 'varios', desc: 'Configuraciones de Swift Package Manager.' },
  { name: 'XCODE_PACKAGE_DISABLE_SANDBOX', type: 'bool', desc: 'Desactiva sandbox de SPM.' },

  // --- Documentación ---
  { name: 'DOCC_*', type: 'varios', desc: 'DocC settings (DOCC_HOSTING_BASE_PATH, etc.).' },
  { name: 'DOCUMENTATION_FOLDER', type: 'path', desc: 'Ruta de .docc.' },

  // --- Others ---
  { name: 'ALTERNATE_*_NAMES', type: 'list', desc: 'Nombres alternativos (permissions, icons).' },
  { name: 'ADDITIONAL_*_FLAGS', type: 'list', desc: 'Flags extra al compilar.' },
  { name: 'DEFAULT_COMPILER', type: 'enum', desc: 'apple-clang por defecto.' },
  { name: 'LAUNCHSCREEN_*', type: 'varios', desc: 'Launch screen settings.' },
];

/* ------------------------------------------------------------------ *
 * 3) Linker flags
 * ------------------------------------------------------------------ */

export const LINKER_FLAGS = [
  { flag: '-framework', arg: 'FrameworkName', desc: 'Enlaza un framework.' },
  { flag: '-weak_framework', arg: 'FrameworkName', desc: 'Enlaza framework débilmente.' },
  { flag: '-l', arg: 'LibraryName', desc: 'Enlaza libNAME.' },
  { flag: '-L', arg: 'path', desc: 'Añade search path para librerías.' },
  { flag: '-F', arg: 'path', desc: 'Añade search path para frameworks.' },
  { flag: '-I', arg: 'path', desc: 'Añade search path de headers (clang).' },
  { flag: '-isysroot', arg: 'path', desc: 'Set sysroot (SDK).' },
  { flag: '-all_load', desc: 'Carga todos los symbols de static libs.' },
  { flag: '-force_load', arg: 'path', desc: 'Fuerza carga de una static lib.' },
  { flag: '-ObjC', desc: 'Carga todas las clases ObjC.' },
  { flag: '-ObjC_load', desc: 'Carga símbolos ObjC referenciados.' },
  { flag: '-dead_strip', desc: 'Elimina código no referenciado.' },
  { flag: '-no_dead_strip_inits_and_terms', desc: 'Preserva inits y terms.' },
  { flag: '-rpath', arg: 'path', desc: 'Añade runpath search path.' },
  { flag: '-install_name', arg: 'name', desc: 'install_name de dylib.' },
  { flag: '-current_version', arg: 'x.y.z', desc: 'Versión actual de dylib.' },
  { flag: '-compatibility_version', arg: 'x.y.z', desc: 'Compatibilidad mínima.' },
  { flag: '-bundle', desc: 'Linkea como bundle (loadable).' },
  { flag: '-dylib', desc: 'Linkea como dylib.' },
  { flag: '-dynamiclib', desc: 'Igual que -dylib.' },
  { flag: '-static', desc: 'Linkea static.' },
  { flag: '-pie', desc: 'Position-independent executable.' },
  { flag: '-no_pie', desc: 'Deshabilita PIE.' },
  { flag: '-pagezero_size', arg: 'size', desc: 'Tamaño de página cero.' },
  { flag: '-image_base', arg: 'addr', desc: 'Base address.' },
  { flag: '-segprot', arg: 'seg max init', desc: 'Set protection de segmento.' },
  { flag: '-segcreate', arg: 'seg file off size', desc: 'Crea segmento.' },
  { flag: '-sectcreate', arg: 'seg sect file', desc: 'Crea sección.' },
  { flag: '-sectorder', arg: 'seg sect order', desc: 'Orden de símbolos en sección.' },
  { flag: '-exported_symbol', arg: 'sym', desc: 'Exporta símbolo.' },
  { flag: '-exported_symbols_list', arg: 'file', desc: 'Fichero con lista de exports.' },
  { flag: '-unexported_symbol', arg: 'sym', desc: 'No exporta símbolo.' },
  { flag: '-unexported_symbols_list', arg: 'file', desc: 'Fichero de no-exports.' },
  { flag: '-reexport_library', arg: 'path', desc: 'Reexporta lib.' },
  { flag: '-reexport_framework', arg: 'name', desc: 'Reexporta framework.' },
  { flag: '-alias', arg: 'sym1 sym2', desc: 'Alias.' },
  { flag: '-undefined', arg: 'error|warning|suppress|dynamic_lookup', desc: 'Comportamiento de undefined symbols.' },
  { flag: '-flat_namespace', desc: 'Flat namespace (two-level por defecto).' },
  { flag: '-twolevel_namespace', desc: 'Two-level namespace.' },
  { flag: '-headerpad', arg: 'size', desc: 'Padding para headers.' },
  { flag: '-headerpad_max_install_names', desc: 'Padding para install_name largos.' },
  { flag: '-no_weak_imports', desc: 'Fallar si hay weak imports.' },
  { flag: '-weak_library', arg: 'path', desc: 'Weak lib.' },
  { flag: '-stack_size', arg: 'size', desc: 'Tamaño de stack.' },
  { flag: '-syslibroot', arg: 'path', desc: 'Syslibroot.' },
  { flag: '-add_ast_path', arg: 'path', desc: 'Añade AST path (Swift).' },
  { flag: '-add_linker_option', arg: 'opt', desc: 'Añade opción al linker.' },
  { flag: '-object_path_lto', arg: 'path', desc: 'LTO object output.' },
  { flag: '-bitcode_bundle', desc: 'Bundle de bitcode.' },
  { flag: '-no_deduplicate', desc: 'No deduplicar.' },
  { flag: '-unexported_symbols_list', arg: 'file', desc: 'Lista de símbolos no exportados.' },
  { flag: '-mark_dead_strippable_dylib', desc: 'Marca dylib como dead-strippable.' },
  { flag: '-platform_version', arg: 'platform min sdk', desc: 'Platform version.' },
  { flag: '-application_extension', desc: 'Linkear como app extension.' },
  { flag: '-no_application_extension', desc: 'Desactiva restricción de app extension.' },
  { flag: '-mllvm', arg: 'opt', desc: 'Opción LLVM.' },
  { flag: '-Xlinker', arg: 'opt', desc: 'Pasa opción directamente al linker.' },
];

/* ------------------------------------------------------------------ *
 * 4) Compiler flags (clang)
 * ------------------------------------------------------------------ */

export const COMPILER_FLAGS = [
  { flag: '-O0', desc: 'Sin optimización (debug).' },
  { flag: '-O1', desc: 'Optimización mínima.' },
  { flag: '-O2', desc: 'Optimización.' },
  { flag: '-O3', desc: 'Optimización agresiva.' },
  { flag: '-Os', desc: 'Optimizar por tamaño.' },
  { flag: '-Ofast', desc: 'Optimización máxima (no estándar).' },
  { flag: '-Oz', desc: 'Optimizar por tamaño (clang).' },
  { flag: '-g', desc: 'Debug info.' },
  { flag: '-g3', desc: 'Debug info máxima.' },
  { flag: '-ggdb', desc: 'Debug info GDB.' },
  { flag: '-Wall', desc: 'Todos los warnings.' },
  { flag: '-Wextra', desc: 'Warnings extra.' },
  { flag: '-Werror', desc: 'Warnings como errores.' },
  { flag: '-Wno-*', desc: 'Desactiva warning específico.' },
  { flag: '-Wpedantic', desc: 'Warnings pedantes (ISO).' },
  { flag: '-Wconversion', desc: 'Warnings de conversiones.' },
  { flag: '-Wshadow', desc: 'Warnings de shadowing.' },
  { flag: '-Wunused', desc: 'Warnings de código no usado.' },
  { flag: '-Wdeprecated-declarations', desc: 'Warnings de API deprecated.' },
  { flag: '-std=c99|c11|c17|c23', desc: 'Estándar C.' },
  { flag: '-std=c++11|c++14|c++17|c++20|c++23', desc: 'Estándar C++.' },
  { flag: '-stdlib=libc++', desc: 'Usar libc++.' },
  { flag: '-arch', arg: 'arch', desc: 'Arquitectura.' },
  { flag: '-target', arg: 'triple', desc: 'Target triple.' },
  { flag: '-isysroot', arg: 'path', desc: 'Sysroot.' },
  { flag: '-I', arg: 'path', desc: 'Include path.' },
  { flag: '-isystem', arg: 'path', desc: 'System include path.' },
  { flag: '-iquote', arg: 'path', desc: 'Quote include path.' },
  { flag: '-D', arg: 'NAME=value', desc: 'Define.' },
  { flag: '-U', arg: 'NAME', desc: 'Undefine.' },
  { flag: '-fPIC', desc: 'Position-independent code.' },
  { flag: '-fPIE', desc: 'Position-independent executable.' },
  { flag: '-fno-common', desc: 'Sin common blocks.' },
  { flag: '-fblocks', desc: 'Blocks (clang).' },
  { flag: '-fobjc-arc', desc: 'ARC.' },
  { flag: '-fobjc-weak', desc: 'Weak refs.' },
  { flag: '-fmodules', desc: 'Modules.' },
  { flag: '-fcxx-modules', desc: 'C++ modules.' },
  { flag: '-fsanitize=address', desc: 'AddressSanitizer.' },
  { flag: '-fsanitize=thread', desc: 'ThreadSanitizer.' },
  { flag: '-fsanitize=undefined', desc: 'UBSan.' },
  { flag: '-fsanitize=memory', desc: 'MemorySanitizer.' },
  { flag: '-fno-omit-frame-pointer', desc: 'Preserva frame pointer.' },
  { flag: '-fstack-protector-all', desc: 'Stack protector completo.' },
  { flag: '-fvisibility=hidden', desc: 'Visibilidad hidden por defecto.' },
  { flag: '-fvisibility=default', desc: 'Visibilidad default.' },
  { flag: '-flto', desc: 'Link-Time Optimization.' },
  { flag: '-fembed-bitcode', desc: 'Bitcode embebido.' },
  { flag: '-c', desc: 'Compilar a object, no linkear.' },
  { flag: '-S', desc: 'Emitir assembly.' },
  { flag: '-E', desc: 'Preprocess only.' },
  { flag: '-M', desc: 'Dependencias.' },
  { flag: '-MMD', desc: 'Dependencias sin sistema.' },
  { flag: '-o', arg: 'file', desc: 'Output.' },
  { flag: '-x', arg: 'lang', desc: 'Forzar lenguaje.' },
  { flag: '-pthread', desc: 'Pthreads.' },
  { flag: '-fopenmp', desc: 'OpenMP.' },
  { flag: '-fprofile-instr-generate', desc: 'Cobertura clang.' },
  { flag: '-fcoverage-mapping', desc: 'Cobertura mapping.' },
];

/* ------------------------------------------------------------------ *
 * 5) Swift flags (swiftc / swift frontend)
 * ------------------------------------------------------------------ */

export const SWIFT_FLAGS = [
  { flag: '-O', desc: 'Optimización.' },
  { flag: '-Onone', desc: 'Sin optimización.' },
  { flag: '-Osize', desc: 'Optimización por tamaño.' },
  { flag: '-g', desc: 'Debug info.' },
  { flag: '-wmo', desc: 'Whole Module Optimization.' },
  { flag: '-enable-testing', desc: 'Habilita @testable.' },
  { flag: '-enable-library-evolution', desc: 'Resiliencia ABI.' },
  { flag: '-emit-module', desc: 'Emite módulo.' },
  { flag: '-emit-module-path', arg: 'file', desc: 'Ruta del módulo.' },
  { flag: '-emit-objc-header', desc: 'Genera header ObjC.' },
  { flag: '-emit-objc-header-path', arg: 'file', desc: 'Ruta del header.' },
  { flag: '-emit-executable', desc: 'Emite ejecutable.' },
  { flag: '-emit-library', desc: 'Emite dylib.' },
  { flag: '-parse-as-library', desc: 'Trata como librería.' },
  { flag: '-static', desc: 'Linkea estático.' },
  { flag: '-parse', desc: 'Solo parse.' },
  { flag: '-typecheck', desc: 'Solo typecheck.' },
  { flag: '-frontend', desc: 'Ejecuta frontend.' },
  { flag: '-c', desc: 'Compilar a object.' },
  { flag: '-o', arg: 'file', desc: 'Output.' },
  { flag: '-I', arg: 'path', desc: 'Include path.' },
  { flag: '-L', arg: 'path', desc: 'Library path.' },
  { flag: '-F', arg: 'path', desc: 'Framework path.' },
  { flag: '-l', arg: 'lib', desc: 'Link lib.' },
  { flag: '-framework', arg: 'name', desc: 'Link framework.' },
  { flag: '-Xcc', arg: 'flag', desc: 'Pasa flag al clang subyacente.' },
  { flag: '-Xlinker', arg: 'flag', desc: 'Pasa flag al linker.' },
  { flag: '-D', arg: 'NAME', desc: 'Define compilation condition.' },
  { flag: '-target', arg: 'triple', desc: 'Target triple.' },
  { flag: '-sdk', arg: 'path', desc: 'SDK path.' },
  { flag: '-swift-version', arg: 'n', desc: 'Versión de Swift (5, 6).' },
  { flag: '-module-name', arg: 'name', desc: 'Nombre del módulo.' },
  { flag: '-module-cache-path', arg: 'path', desc: 'Cache de módulos.' },
  { flag: '-enable-batch-mode', desc: 'Batch mode.' },
  { flag: '-disable-batch-mode', desc: 'Disable batch mode.' },
  { flag: '-whole-module-optimization', desc: 'WMO.' },
  { flag: '-cross-module-optimization', desc: 'CMO.' },
  { flag: '-enable-experimental-feature', arg: 'name', desc: 'Activa feature experimental.' },
  { flag: '-enable-upcoming-feature', arg: 'name', desc: 'Activa upcoming feature.' },
  { flag: '-disable-upcoming-feature', arg: 'name', desc: 'Desactiva upcoming feature.' },
  { flag: '-strict-concurrency', arg: 'minimal|targeted|complete', desc: 'Strict concurrency.' },
  { flag: '-warn-concurrency', desc: 'Warnings de concurrency.' },
  { flag: '-enable-actor-data-race-checks', desc: 'Actor race checks.' },
  { flag: '-warnings-as-errors', desc: 'Warnings como errores.' },
  { flag: '-suppress-warnings', desc: 'Suprime warnings.' },
  { flag: '-no-color-diagnostics', desc: 'Sin color en diagnósticos.' },
  { flag: '-serialize-diagnostics', desc: 'Serializa diags.' },
  { flag: '-debug-info-format', arg: 'dwarf|codeview', desc: 'Formato de debug info.' },
  { flag: '-debug-info-store-invocation', desc: 'Invocation en debug info.' },
  { flag: '-incremental', desc: 'Compilación incremental.' },
  { flag: '-driver-print-jobs', desc: 'Imprime jobs del driver.' },
  { flag: '-v', desc: 'Verbose.' },
];

/* ------------------------------------------------------------------ *
 * 6) Clang warnings (CLANG_WARN_*)
 * ------------------------------------------------------------------ */

export const CLANG_WARNINGS = [
  'CLANG_WARN_ASSIGN_ENUM',
  'CLANG_WARN_BLOCK_CAPTURE_AUTORELEASING',
  'CLANG_WARN_BOOL_CONVERSION',
  'CLANG_WARN_COMMA',
  'CLANG_WARN_CONSTANT_CONVERSION',
  'CLANG_WARN_DEPRECATED_OBJC_IMPLEMENTATIONS',
  'CLANG_WARN_DIRECT_OBJC_ISA_USAGE',
  'CLANG_WARN_DOCUMENTATION_COMMENTS',
  'CLANG_WARN_EMPTY_BODY',
  'CLANG_WARN_ENUM_CONVERSION',
  'CLANG_WARN_INFINITE_RECURSION',
  'CLANG_WARN_INT_CONVERSION',
  'CLANG_WARN_NON_LITERAL_NULL_CONVERSION',
  'CLANG_WARN_OBJC_IMPLICIT_RETAIN_SELF',
  'CLANG_WARN_OBJC_LITERAL_CONVERSION',
  'CLANG_WARN_OBJC_ROOT_CLASS',
  'CLANG_WARN_OBJC_ARC_UNAVAILABLE',
  'CLANG_WARN_QUOTED_INCLUDE_IN_FRAMEWORK_HEADER',
  'CLANG_WARN_RANGE_LOOP_ANALYSIS',
  'CLANG_WARN_STRICT_PROTOTYPES',
  'CLANG_WARN_SUSPICIOUS_MOVE',
  'CLANG_WARN_UNGUARDED_AVAILABILITY',
  'CLANG_WARN_UNREACHABLE_CODE',
  'CLANG_WARN__DUPLICATE_METHOD_MATCH',
];

/* ------------------------------------------------------------------ *
 * 7) Schemes / workflows
 * ------------------------------------------------------------------ */

export const WORKFLOWS = [
  { name: 'Build', desc: 'Compilar el target.', steps: ['Compile sources', 'Link', 'Copy resources', 'Sign'] },
  { name: 'Clean Build Folder', shortcut: '⇧⌘K', desc: 'Limpia DerivedData del proyecto.' },
  { name: 'Archive', shortcut: '⌘⇧A', desc: 'Crea un xcarchive firmado.' },
  { name: 'Distribute App', desc: 'Wizard de export (App Store, Ad Hoc, Enterprise, Development).' },
  { name: 'Upload to App Store Connect', desc: 'Subir build.' },
  { name: 'Validate App', desc: 'Validar antes de subir.' },
  { name: 'Test', shortcut: '⌘U', desc: 'Ejecutar tests del scheme.' },
  { name: 'Test Without Building', shortcut: '⌘⌥U', desc: 'Ejecutar tests sin rebuild.' },
  { name: 'Profile', shortcut: '⌘I', desc: 'Ejecutar bajo Instruments.' },
  { name: 'Analyze', shortcut: '⇧⌘B', desc: 'Static analyzer.' },
  { name: 'Run', shortcut: '⌘R', desc: 'Ejecutar en destination.' },
  { name: 'Stop', shortcut: '⌘.', desc: 'Detener ejecución.' },
  { name: 'Edit Scheme', shortcut: '⌘<', desc: 'Editor de schemes.' },
  { name: 'Manage Schemes', shortcut: '⇧⌘,', desc: 'Lista de schemes.' },
];

/* ------------------------------------------------------------------ *
 * 8) Keyboard shortcuts
 * ------------------------------------------------------------------ */

export const SHORTCUTS = [
  { keys: '⌘R', action: 'Run' },
  { keys: '⌘.', action: 'Stop' },
  { keys: '⌘B', action: 'Build' },
  { keys: '⇧⌘B', action: 'Analyze' },
  { keys: '⌘U', action: 'Test' },
  { keys: '⌘I', action: 'Profile' },
  { keys: '⇧⌘K', action: 'Clean Build Folder' },
  { keys: '⌘K', action: 'Clear Console' },
  { keys: '⌘0', action: 'Show/hide Navigator' },
  { keys: '⌥⌘0', action: 'Show/hide Inspector' },
  { keys: '⇧⌘Y', action: 'Show/hide Debug Area' },
  { keys: '⇧⌘C', action: 'Show/hide Console' },
  { keys: '⌘1..9', action: 'Seleccionar tab del Navigator' },
  { keys: '⌃⌘←/→', action: 'Navegar hacia atrás/adelante' },
  { keys: '⌘↩', action: 'Build & Run' },
  { keys: '⌘/', action: 'Comment/Uncomment' },
  { keys: '⌃I', action: 'Reindentar' },
  { keys: '⌘F', action: 'Find' },
  { keys: '⌥⌘F', action: 'Find & Replace' },
  { keys: '⇧⌘F', action: 'Find in Project' },
  { keys: '⌘G', action: 'Find Next' },
  { keys: '⇧⌘G', action: 'Find Previous' },
  { keys: '⌃⌘E', action: 'Edit All in Scope' },
  { keys: '⌘\'', action: 'Next Issue' },
  { keys: '⇧⌘\'', action: 'Previous Issue' },
  { keys: '⌘\\', action: 'Toggle Breakpoint' },
  { keys: '⌥⌘\\', action: 'Edit Breakpoint' },
  { keys: '⌘Y', action: 'Activate Breakpoints' },
  { keys: 'F6', action: 'Step Over' },
  { keys: 'F7', action: 'Step Into' },
  { keys: 'F8', action: 'Step Out' },
  { keys: '⌃⌘Y', action: 'Continue' },
  { keys: '⌘D', action: 'Duplicate Line' },
  { keys: '⌥⌘[', action: 'Move Line Up' },
  { keys: '⌥⌘]', action: 'Move Line Down' },
  { keys: '⇧⌘N', action: 'New File' },
  { keys: '⌥⌘N', action: 'New Group' },
  { keys: '⌃⌘N', action: 'New Workspace' },
  { keys: '⌘O', action: 'Open' },
  { keys: '⌥⌘O', action: 'Open Quickly' },
  { keys: '⇧⌘O', action: 'Open in Swift Playgrounds' },
  { keys: '⌘W', action: 'Close' },
  { keys: '⌥⌘W', action: 'Close All' },
  { keys: '⌘S', action: 'Save' },
  { keys: '⌥⌘S', action: 'Save All' },
  { keys: '⇧⌘S', action: 'Save As' },
  { keys: '⌘P', action: 'Print' },
  { keys: '⌘Z', action: 'Undo' },
  { keys: '⇧⌘Z', action: 'Redo' },
  { keys: '⌘X/⌘C/⌘V', action: 'Cut/Copy/Paste' },
  { keys: '⌥⌘⇧V', action: 'Paste & Match Style' },
  { keys: '⇧⌘T', action: 'Open in Terminal' },
  { keys: '⌥⌘P', action: 'Resume SwiftUI Preview' },
  { keys: '⌥⌘↩', action: 'Show Preview' },
  { keys: '⌃⌥⌘P', action: 'Refresh Previews' },
];

/* ------------------------------------------------------------------ *
 * 9) Instruments (xctrace templates)
 * ------------------------------------------------------------------ */

export const INSTRUMENTS = [
  'Time Profiler', 'Allocations', 'Leaks', 'Zombies',
  'Activity Monitor', 'File Activity', 'Core Data',
  'System Trace', 'Metal System Trace', 'GPU Driver',
  'Energy Log', 'Network', 'Wi-Fi', 'Bluetooth',
  'Automation', 'Animation Hitches', 'SwiftUI',
  'Swift Concurrency', 'Game Performance', 'Hitches',
  'Memory Graph', 'VM Tracker', 'SceneKit', 'Metal',
  'RealityKit', 'ARKit', 'Core ML', 'Core Animation',
  'StoreKit Transactions', 'Swift Tasks',
];

/* ------------------------------------------------------------------ *
 * 10) SDKs / platforms
 * ------------------------------------------------------------------ */

export const SDKS = [
  { name: 'iphoneos', platform: 'iOS', desc: 'SDK de dispositivo iOS.' },
  { name: 'iphonesimulator', platform: 'iOS Simulator', desc: 'SDK de simulador iOS.' },
  { name: 'macosx', platform: 'macOS', desc: 'SDK de macOS.' },
  { name: 'watchos', platform: 'watchOS', desc: 'SDK de watchOS dispositivo.' },
  { name: 'watchsimulator', platform: 'watchOS Simulator', desc: 'SDK simulador watchOS.' },
  { name: 'appletvos', platform: 'tvOS', desc: 'SDK de tvOS.' },
  { name: 'appletvsimulator', platform: 'tvOS Simulator', desc: 'SDK simulador tvOS.' },
  { name: 'xros', platform: 'visionOS', desc: 'SDK de visionOS.' },
  { name: 'xrsimulator', platform: 'visionOS Simulator', desc: 'SDK simulador visionOS.' },
  { name: 'driverkit', platform: 'DriverKit', desc: 'SDK de DriverKit.' },
];

/* ------------------------------------------------------------------ *
 * 11) File types
 * ------------------------------------------------------------------ */

export const FILE_TYPES = [
  { ext: '.xcodeproj', desc: 'Proyecto Xcode.' },
  { ext: '.xcworkspace', desc: 'Workspace (múltiples proyectos/packages).' },
  { ext: '.xcscheme', desc: 'Scheme (dentro de xcshareddata).' },
  { ext: '.xcconfig', desc: 'Build settings file.' },
  { ext: '.xcassets', desc: 'Asset catalog.' },
  { ext: '.xcdatamodeld', desc: 'Core Data model.' },
  { ext: '.xcmappingmodel', desc: 'Core Data mapping.' },
  { ext: '.xctest', desc: 'Test bundle.' },
  { ext: '.xcresult', desc: 'Test/result bundle.' },
  { ext: '.xcarchive', desc: 'Archive de distribución.' },
  { ext: '.xcframework', desc: 'Multi-platform framework.' },
  { ext: '.xib', desc: 'Interface Builder (archivo).' },
  { ext: '.storyboard', desc: 'Storyboard.' },
  { ext: '.swift', desc: 'Swift source.' },
  { ext: '.m', desc: 'Objective-C source.' },
  { ext: '.mm', desc: 'Objective-C++ source.' },
  { ext: '.h', desc: 'Header.' },
  { ext: '.cpp/.cc/.cxx', desc: 'C++ source.' },
  { ext: '.c', desc: 'C source.' },
  { ext: '.metal', desc: 'Metal shader.' },
  { ext: '.strings', desc: 'Localization strings.' },
  { ext: '.stringsdict', desc: 'Plural rules.' },
  { ext: '.xcstrings', desc: 'String Catalog.' },
  { ext: '.plist', desc: 'Property list.' },
  { ext: '.entitlements', desc: 'Entitlements plist.' },
  { ext: '.mobileprovision', desc: 'Provisioning profile.' },
  { ext: '.ipa', desc: 'iOS app package.' },
  { ext: '.app', desc: 'Application bundle.' },
  { ext: '.framework', desc: 'Framework bundle.' },
  { ext: '.dylib', desc: 'Dynamic library.' },
  { ext: '.a', desc: 'Static library.' },
  { ext: '.docc', desc: 'DocC documentation catalog.' },
  { ext: '.playground', desc: 'Playground.' },
  { ext: '.playgroundbook', desc: 'Playground Book (iPad).' },
  { ext: '.storekit', desc: 'StoreKit configuration.' },
  { ext: '.intentdefinition', desc: 'Siri intent definition.' },
  { ext: '.mlmodel', desc: 'Core ML model.' },
  { ext: '.mlpackage', desc: 'Core ML package.' },
  { ext: '.arobject', desc: 'Reality Composer object.' },
  { ext: '.rcproject', desc: 'Reality Composer project.' },
  { ext: '.usdz', desc: 'Universal Scene Description (USD).' },
  { ext: '.scn', desc: 'SceneKit scene.' },
  { ext: '.sks', desc: 'SpriteKit scene.' },
  { ext: '.xcdistribution', desc: 'Distribution summary.' },
  { ext: '.bcsymbolmap', desc: 'Bitcode symbol map.' },
  { ext: '.dSYM', desc: 'Debug symbols.' },
  { ext: '.swiftinterface', desc: 'Swift module interface (ABI estable).' },
  { ext: '.swiftmodule', desc: 'Swift module binario.' },
  { ext: '.swiftdoc', desc: 'Documentación de módulo.' },
  { ext: '.modulemap', desc: 'Clang module map.' },
];

/* ------------------------------------------------------------------ *
 * 12) xcconfig keys (más comunes)
 * ------------------------------------------------------------------ */

export const XCCONFIG_KEYS = [
  { key: '//', desc: 'Comentario.' },
  { key: '//!', desc: 'Comentario block.' },
  { key: '#include', arg: '"path"', desc: 'Incluye otro xcconfig.' },
  { key: '#include?', arg: '"path"', desc: 'Incluye si existe.' },
  { key: '$(VARIABLE)', desc: 'Sustitución de variable.' },
  { key: '$(inherited)', desc: 'Hereda el valor del nivel superior.' },
  { key: '$(SRCROOT)', desc: 'Raíz de fuentes.' },
  { key: '$(PROJECT_DIR)', desc: 'Directorio del proyecto.' },
  { key: '$(CONFIGURATION)', desc: 'Configuración (Debug/Release).' },
  { key: '$(SDKROOT)', desc: 'SDK root.' },
  { key: '$(PLATFORM_NAME)', desc: 'Nombre de la platform.' },
  { key: '$(EFFECTIVE_PLATFORM_NAME)', desc: 'Platform con -simulator si aplica.' },
  { key: '$(ARCHS_STANDARD)', desc: 'Arquitecturas por defecto.' },
  { key: '$(DEVELOPER_DIR)', desc: 'Path de Xcode.' },
  { key: '$(TOOLCHAIN_DIR)', desc: 'Path del toolchain.' },
  { key: '$(USER)', desc: 'Usuario actual.' },
  { key: '$(HOME)', desc: 'HOME del usuario.' },
  { key: '$(SRCROOT)', desc: 'Raíz de fuentes.' },
  { key: '$(BUILT_PRODUCTS_DIR)', desc: 'Directorio de productos.' },
  { key: '$(TARGET_BUILD_DIR)', desc: 'Directorio de build del target.' },
  { key: '$(TARGET_NAME)', desc: 'Nombre del target.' },
  { key: '$(PRODUCT_NAME)', desc: 'Nombre del producto.' },
  { key: '$(VARIANT)', desc: 'normal o simulator.' },
  { key: '$(PLATFORM_DIR)', desc: 'Path de la platform.' },
  { key: '$(PLATFORM_PREFERRED_ARCH)', desc: 'Arquitectura preferida por platform.' },
];

/* ------------------------------------------------------------------ *
 * 13) Info.plist keys (más usadas)
 * ------------------------------------------------------------------ */

export const INFOPLIST_KEYS = [
  { key: 'CFBundleDisplayName', desc: 'Nombre visible de la app.' },
  { key: 'CFBundleName', desc: 'Nombre corto.' },
  { key: 'CFBundleIdentifier', desc: 'Bundle ID.' },
  { key: 'CFBundleVersion', desc: 'Build number.' },
  { key: 'CFBundleShortVersionString', desc: 'Marketing version.' },
  { key: 'CFBundlePackageType', desc: 'APPL, XPC!, etc.' },
  { key: 'CFBundleExecutable', desc: 'Nombre del ejecutable.' },
  { key: 'CFBundleIconName', desc: 'Nombre del AppIcon.' },
  { key: 'CFBundleURLTypes', desc: 'Esquemas URL custom.' },
  { key: 'CFBundleDocumentTypes', desc: 'Tipos de documento.' },
  { key: 'LSApplicationQueriesSchemes', desc: 'Esquemas consultables (canOpenURL).' },
  { key: 'UILaunchStoryboardName', desc: 'Storyboard de launch.' },
  { key: 'UILaunchScreen', desc: 'Launch screen dict (iOS 14+).' },
  { key: 'UISupportedInterfaceOrientations', desc: 'Orientaciones soportadas.' },
  { key: 'UIApplicationSceneManifest', desc: 'Config de escenas.' },
  { key: 'UIApplicationSupportsMultipleScenes', desc: 'Multi-ventana.' },
  { key: 'UIRequiredDeviceCapabilities', desc: 'Capacidades HW requeridas.' },
  { key: 'UIBackgroundModes', desc: 'Modos en background.' },
  { key: 'UIStatusBarStyle', desc: 'Estilo de status bar.' },
  { key: 'UIViewControllerBasedStatusBarAppearance', desc: 'Control por VC.' },
  { key: 'UIUserInterfaceStyle', desc: 'Light/Dark/Automatic.' },
  { key: 'UIRequiresFullScreen', desc: 'Requiere pantalla completa (iPad).' },
  { key: 'NSCameraUsageDescription', desc: 'Descripción de uso de cámara.' },
  { key: 'NSMicrophoneUsageDescription', desc: 'Uso de micrófono.' },
  { key: 'NSPhotoLibraryUsageDescription', desc: 'Uso de fotos.' },
  { key: 'NSPhotoLibraryAddUsageDescription', desc: 'Añadir a fotos.' },
  { key: 'NSLocationWhenInUseUsageDescription', desc: 'Ubicación en uso.' },
  { key: 'NSLocationAlwaysAndWhenInUseUsageDescription', desc: 'Ubicación siempre.' },
  { key: 'NSContactsUsageDescription', desc: 'Contactos.' },
  { key: 'NSCalendarsUsageDescription', desc: 'Calendarios.' },
  { key: 'NSRemindersUsageDescription', desc: 'Recordatorios.' },
  { key: 'NSBluetoothAlwaysUsageDescription', desc: 'Bluetooth.' },
  { key: 'NSBluetoothPeripheralUsageDescription', desc: 'Bluetooth periférico.' },
  { key: 'NSLocalNetworkUsageDescription', desc: 'Red local.' },
  { key: 'NFCReaderUsageDescription', desc: 'NFC.' },
  { key: 'NSFaceIDUsageDescription', desc: 'Face ID.' },
  { key: 'NSHealthShareUsageDescription', desc: 'Leer salud.' },
  { key: 'NSHealthUpdateUsageDescription', desc: 'Escribir salud.' },
  { key: 'NSMotionUsageDescription', desc: 'Movimiento.' },
  { key: 'NSUserTrackingUsageDescription', desc: 'Tracking (ATT).' },
  { key: 'NSAppTransportSecurity', desc: 'ATS config.' },
  { key: 'NSAllowsArbitraryLoads', desc: 'Permite HTTP sin TLS.' },
  { key: 'NSUbiquitousContainers', desc: 'Contenedores iCloud.' },
  { key: 'UIFileSharingEnabled', desc: 'Compartir ficheros.' },
  { key: 'LSSupportsOpeningDocumentsInPlace', desc: 'Abrir documentos in-place.' },
  { key: 'UIApplicationExitsOnSuspend', desc: '(deprecated) Salir al suspender.' },
  { key: 'ITSAppUsesNonExemptEncryption', desc: 'Uso de cifrado.' },
  { key: 'NSHumanReadableCopyright', desc: 'Copyright.' },
  { key: 'LSRequiresIPhoneOS', desc: 'Requiere iPhone OS.' },
  { key: 'UIRequiredDeviceCapabilities', desc: 'Capacidades requeridas.' },
  { key: 'UIApplicationShortcutItems', desc: 'Quick actions.' },
  { key: 'WKAppBundleIdentifier', desc: 'Companion watch app.' },
  { key: 'WKCompanionAppBundleIdentifier', desc: 'Companion iOS.' },
  { key: 'NSExtension', desc: 'Config de extension.' },
  { key: 'UIBackgroundModes', desc: 'Background modes (audio, location, etc.).' },
];

/* ------------------------------------------------------------------ *
 * 14) Environment variables (útiles en run scripts)
 * ------------------------------------------------------------------ */

export const ENV_VARS = [
  'PROJECT_DIR', 'SRCROOT', 'TARGET_NAME', 'PRODUCT_NAME',
  'BUILT_PRODUCTS_DIR', 'TARGET_BUILD_DIR', 'CONFIGURATION',
  'SDKROOT', 'PLATFORM_NAME', 'EFFECTIVE_PLATFORM_NAME', 'ARCHS',
  'CURRENT_ARCH', 'ONLY_ACTIVE_ARCH', 'BUILD_DIR', 'DERIVED_FILE_DIR',
  'DERIVED_SOURCES_DIR', 'PROJECT_NAME', 'PROJECT_FILE_PATH',
  'TARGETNAME', 'FULL_PRODUCT_NAME', 'EXECUTABLE_PATH', 'EXECUTABLE_NAME',
  'CODE_SIGNING_REQUIRED', 'CODE_SIGNING_ALLOWED', 'CODE_SIGN_IDENTITY',
  'EXPANDED_CODE_SIGN_IDENTITY', 'CODE_SIGN_ENTITLEMENTS',
  'PROVISIONING_PROFILE_SPECIFIER', 'DEVELOPMENT_TEAM',
  'INFOPLIST_PATH', 'INFOPLIST_FILE', 'PUBLIC_HEADERS_FOLDER_PATH',
  'PRIVATE_HEADERS_FOLDER_PATH', 'UNLOCALIZED_RESOURCES_FOLDER_PATH',
  'LOCALIZED_RESOURCES_FOLDER_PATH', 'FRAMEWORKS_FOLDER_PATH',
  'PLUGINS_FOLDER_PATH', 'XPC_SERVICES_FOLDER_PATH',
  'SDK_NAME', 'SDK_VERSION', 'MACOSX_DEPLOYMENT_TARGET',
  'IPHONEOS_DEPLOYMENT_TARGET', 'SWIFT_VERSION', 'SWIFT_OPTIMIZATION_LEVEL',
  'XCODE_VERSION_ACTUAL', 'XCODE_PRODUCT_BUILD_VERSION', 'XCODE_VERSION_MAJOR',
  'USER', 'HOME', 'PATH', 'LANG', 'LC_ALL',
  'ACTION', 'SCRIPT_INPUT_FILE_COUNT', 'SCRIPT_OUTPUT_FILE_COUNT',
];

/* ------------------------------------------------------------------ *
 * 15) Templates / nuevos proyectos
 * ------------------------------------------------------------------ */

export const TEMPLATES = [
  'App', 'App (SwiftUI)', 'App (UIKit, Storyboard)', 'App (UIKit, XIB)',
  'Game (SpriteKit)', 'Game (SceneKit)', 'Game (Metal)', 'Game (RealityKit)',
  'App with Widget Extension', 'App with Watch App', 'App Clip',
  'Document Based App', 'Command Line Tool', 'Framework', 'Static Library',
  'Dynamic Library', 'Bundle', 'Package', 'Xcode Extension',
  'Swift Package Plugin', 'Unit Test Bundle', 'UI Test Bundle',
  'Core Data', 'Metal File', 'SceneKit Scene', 'SpriteKit Scene',
  'RealityKit Scene', 'Playground', 'Playground Book',
  'App Intents Extension', 'Widget Extension', 'Notification Service Extension',
  'Notification Content Extension', 'Share Extension', 'Action Extension',
  'Photo Editing Extension', 'Keyboard Extension', 'Sticker Pack Extension',
  'iMessage Extension', 'Call Directory Extension', 'Network Extension',
  'Safari Extension', 'Broadcast Upload Extension', 'Broadcast Setup UI',
  'Intent Extension', 'File Provider Extension', 'DriverKit Driver',
  'System Extension', 'Audio Unit Extension', 'XPC Service',
];

/* ------------------------------------------------------------------ *
 * Dataset unificado
 * ------------------------------------------------------------------ */

export const XCODE_DATASET = {
  cli:        CLI_TOOLS,
  buildSettings: BUILD_SETTINGS,
  linkerFlags:   LINKER_FLAGS,
  compilerFlags: COMPILER_FLAGS,
  swiftFlags:    SWIFT_FLAGS,
  clangWarnings: CLANG_WARNINGS,
  workflows:     WORKFLOWS,
  shortcuts:     SHORTCUTS,
  instruments:   INSTRUMENTS,
  sdks:          SDKS,
  fileTypes:     FILE_TYPES,
  xcconfig:      XCCONFIG_KEYS,
  plist:         INFOPLIST_KEYS,
  envVars:       ENV_VARS,
  templates:     TEMPLATES,
};

/* ------------------------------------------------------------------ *
 * Motor de búsqueda
 * ------------------------------------------------------------------ */

function normalize(s) {
  return String(s || '').toLowerCase().trim();
}

function scoreItem(query, item, keys) {
  const q = normalize(query);
  if (!q) return 0;
  let score = 0;
  for (const k of keys) {
    const v = normalize(item[k]);
    if (!v) continue;
    if (v === q) score += 100;
    else if (v.startsWith(q)) score += 50;
    else if (v.includes(q)) score += 20;
    // Coincidencia por tokens
    const tokens = q.split(/\s+/);
    for (const t of tokens) {
      if (v.includes(t)) score += 5;
    }
  }
  return score;
}

export function searchXcode(query, { category = null, limit = 25 } = {}) {
  const results = [];
  for (const [cat, items] of Object.entries(XCODE_DATASET)) {
    if (category && cat !== category) continue;
    for (const it of items) {
      const keys = Object.keys(it);
      const s = scoreItem(query, it, keys);
      if (s > 0) results.push({ category: cat, score: s, item: it });
    }
  }
  results.sort((a, b) => b.score - a.score);
  return results.slice(0, limit);
}

export function findByName(name, { category = null } = {}) {
  const n = normalize(name);
  for (const [cat, items] of Object.entries(XCODE_DATASET)) {
    if (category && cat !== category) continue;
    for (const it of items) {
      const candidates = [it.name, it.flag, it.key, it.ext, it.keys, it.command];
      if (candidates.some(c => normalize(c) === n)) return { category: cat, item: it };
    }
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * Render de ayuda (texto plano, para Terminal app)
 * ------------------------------------------------------------------ */

export function renderHelp(entry, { width = 80 } = {}) {
  if (!entry) return '';
  const { category, item } = entry;
  const lines = [];
  const header = `── ${category.toUpperCase()} ──`;
  lines.push(header);
  lines.push('');
  for (const [k, v] of Object.entries(item)) {
    if (v == null || v === '') continue;
    const val = Array.isArray(v) ? v.join(', ') : String(v);
    lines.push(`  ${String(k).padEnd(14)} ${val}`);
  }
  return lines.join('\n');
}

export function listCategories() {
  return Object.entries(XCODE_DATASET).map(([k, v]) => ({
    category: k,
    count: v.length,
  }));
}

/* ------------------------------------------------------------------ *
 * Clase XcodeHelp — API cómoda para la app Terminal / UI
 * ------------------------------------------------------------------ */

export class XcodeHelp {
  constructor() {
    this.dataset = XCODE_DATASET;
    this.history = [];
  }

  search(query, opts) {
    const r = searchXcode(query, opts);
    this.history.push({ q: query, t: Date.now(), results: r.length });
    return r;
  }

  find(name, opts) { return findByName(name, opts); }

  help(name) {
    const found = this.find(name);
    return found ? renderHelp(found) : `No encontrado: ${name}`;
  }

  categories() { return listCategories(); }

  byCategory(cat) {
    const items = this.dataset[cat];
    if (!items) return null;
    return items;
  }

  dump() {
    Logger.kernel(LOG_TAG, '─── XcodeHelp ───');
    for (const { category, count } of this.categories()) {
      Logger.kernel(LOG_TAG, `  ${category.padEnd(16)} ${count}`);
    }
  }
}

export default {
  XCODE_CATEGORY,
  XCODE_DATASET,
  CLI_TOOLS,
  BUILD_SETTINGS,
  LINKER_FLAGS,
  COMPILER_FLAGS,
  SWIFT_FLAGS,
  CLANG_WARNINGS,
  WORKFLOWS,
  SHORTCUTS,
  INSTRUMENTS,
  SDKS,
  FILE_TYPES,
  XCCONFIG_KEYS,
  INFOPLIST_KEYS,
  ENV_VARS,
  TEMPLATES,
  searchXcode,
  findByName,
  renderHelp,
  listCategories,
  XcodeHelp,
};
