// Copyright (c) 2026 Ravi. MIT license; see LICENSE in this distribution.
// Keep permission checks and event posting inside the authorized app process.
#import <Cocoa/Cocoa.h>
#include <node_api.h>
#include <cmath>
#include <cstdint>
#include <cstring>

namespace {
bool check(napi_env env, napi_status status) {
  if (status == napi_ok) return true;
  if (status != napi_pending_exception)
    napi_throw_error(env, nullptr, "Native dictation operation failed");
  return false;
}

bool onMainThread(napi_env env) {
  if ([NSThread isMainThread]) return true;
  napi_throw_error(env, nullptr, "Native dictation must run on the main thread");
  return false;
}

bool noArguments(napi_env env, napi_callback_info info) {
  size_t count = 1;
  napi_value argument;
  if (!check(env, napi_get_cb_info(env, info, &count, &argument, nullptr, nullptr))) return false;
  if (count == 0) return true;
  napi_throw_type_error(env, nullptr, "This operation takes no arguments");
  return false;
}

napi_value statusResult(napi_env env, const char *status) {
  napi_value result, value;
  if (!check(env, napi_create_object(env, &result)) ||
      !check(env, napi_create_string_utf8(env, status, NAPI_AUTO_LENGTH, &value)) ||
      !check(env, napi_set_named_property(env, result, "status", value))) return nullptr;
  return result;
}

bool hasAccessibility() {
  // Neither API prompts or changes the user's permission setting.
  return AXIsProcessTrusted() && CGPreflightPostEventAccess();
}

napi_value accessibility(napi_env env, napi_callback_info info) {
  if (!onMainThread(env) || !noArguments(env, info)) return nullptr;
  napi_value result;
  if (!check(env, napi_get_boolean(env, hasAccessibility(), &result))) return nullptr;
  return result;
}

napi_value captureTarget(napi_env env, napi_callback_info info) {
  if (!onMainThread(env) || !noArguments(env, info)) return nullptr;
  @autoreleasepool {
    NSRunningApplication *target = NSWorkspace.sharedWorkspace.frontmostApplication;
    napi_value result, pid, bundleId, name;
    if (!target || target.processIdentifier <= 0) {
      if (!check(env, napi_get_null(env, &result))) return nullptr;
      return result;
    }
    const char *identifier = (target.bundleIdentifier ?: @"").UTF8String;
    if (!check(env, napi_create_object(env, &result)) ||
        !check(env, napi_create_int32(env, target.processIdentifier, &pid)) ||
        !check(env, napi_create_string_utf8(env, identifier, NAPI_AUTO_LENGTH, &bundleId)) ||
        !check(env, napi_create_string_utf8(env, (target.localizedName ?: target.bundleIdentifier ?: @"").UTF8String, NAPI_AUTO_LENGTH, &name)) ||
        !check(env, napi_set_named_property(env, result, "pid", pid)) ||
        !check(env, napi_set_named_property(env, result, "name", name)) ||
        !check(env, napi_set_named_property(env, result, "bundleId", bundleId))) return nullptr;
    return result;
  }
}

struct Event {
  CGEventRef value;
  ~Event() { if (value) CFRelease(value); }
};

napi_value paste(napi_env env, napi_callback_info info) {
  if (!onMainThread(env)) return nullptr;
  // An extra argument slot detects surplus arguments without coercing values.
  size_t count = 3;
  napi_value arguments[3];
  if (!check(env, napi_get_cb_info(env, info, &count, arguments, nullptr, nullptr))) return nullptr;
  napi_valuetype pidType, bundleType;
  if (count != 2) {
    napi_throw_type_error(env, nullptr, "Paste requires a PID and bundle identifier");
    return nullptr;
  }
  if (!check(env, napi_typeof(env, arguments[0], &pidType)) ||
      !check(env, napi_typeof(env, arguments[1], &bundleType))) return nullptr;
  if (pidType != napi_number || bundleType != napi_string) {
    napi_throw_type_error(env, nullptr, "Paste requires a numeric PID and string bundle identifier");
    return nullptr;
  }
  double numericPID;
  size_t length;
  if (!check(env, napi_get_value_double(env, arguments[0], &numericPID)) ||
      !check(env, napi_get_value_string_utf8(env, arguments[1], nullptr, 0, &length))) return nullptr;
  if (!std::isfinite(numericPID) || numericPID < 1 || numericPID > INT32_MAX ||
      std::floor(numericPID) != numericPID || length > 4096) {
    napi_throw_type_error(env, nullptr, "Paste target is invalid");
    return nullptr;
  }
  char identifier[4097];
  size_t copied;
  if (!check(env, napi_get_value_string_utf8(env, arguments[1], identifier, sizeof(identifier), &copied)))
    return nullptr;
  if (copied != length || std::memchr(identifier, '\0', copied)) {
    napi_throw_type_error(env, nullptr, "Paste bundle identifier is invalid");
    return nullptr;
  }

  @autoreleasepool {
    if (!hasAccessibility()) return statusResult(env, "permission-required");
    NSString *expectedBundle = [[NSString alloc] initWithBytes:identifier
                                                      length:copied
                                                    encoding:NSUTF8StringEncoding];
    if (!expectedBundle) return statusResult(env, "unavailable");
    Event down{CGEventCreateKeyboardEvent(nullptr, 0x09, true)};
    Event up{CGEventCreateKeyboardEvent(nullptr, 0x09, false)};
    if (!down.value || !up.value) return statusResult(env, "unavailable");
    CGEventSetFlags(down.value, kCGEventFlagMaskCommand);
    CGEventSetFlags(up.value, kCGEventFlagMaskCommand);

    NSRunningApplication *target = NSWorkspace.sharedWorkspace.frontmostApplication;
    if (!target || target.processIdentifier != static_cast<pid_t>(numericPID) ||
        ![(target.bundleIdentifier ?: @"") isEqualToString:expectedBundle])
      return statusResult(env, "target-changed");

    // One ordered key pair, with no async gap, focus change, or automatic retry.
    CGEventPost(kCGSessionEventTap, down.value);
    CGEventPost(kCGSessionEventTap, up.value);
    return statusResult(env, "dispatched");
  }
}

napi_value initialize(napi_env env, napi_value exports) {
  napi_property_descriptor properties[] = {
    {"accessibility", nullptr, accessibility, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"captureTarget", nullptr, captureTarget, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"paste", nullptr, paste, nullptr, nullptr, nullptr, napi_default, nullptr},
  };
  if (!check(env, napi_define_properties(env, exports, 3, properties))) return nullptr;
  return exports;
}
}  // namespace

NAPI_MODULE(macos_local_paste, initialize)
