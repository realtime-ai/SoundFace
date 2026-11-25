#import <Foundation/Foundation.h>
#import <SystemExtensions/SystemExtensions.h>
#import <Security/Security.h>
#include <node_api.h>

// Loaded by the Electron main executable: OSSystemExtensionRequest must originate
// in the containing application, not in an unrelated command-line helper.
@interface SFActivation : NSObject <OSSystemExtensionRequestDelegate>
@end
static SFActivation *delegate;
static NSDictionary *state;
static BOOL pending = NO;
static void update(NSString *phase, NSDictionary *details) {
    @synchronized(SFActivation.class) {
        NSMutableDictionary *next = [@{@"phase": phase} mutableCopy];
        if (details) [next addEntriesFromDictionary:details];
        state = next;
    }
}
@implementation SFActivation
- (void)requestNeedsUserApproval:(OSSystemExtensionRequest *)request {
    update(@"awaiting_approval", @{@"message": @"请到“系统设置 → 通用 → 登录项与扩展 → 摄像头扩展”里允许 SoundFace。"});
}
- (OSSystemExtensionReplacementAction)request:(OSSystemExtensionRequest *)request actionForReplacingExtension:(OSSystemExtensionProperties *)existing withExtension:(OSSystemExtensionProperties *)replacement {
    // Never silently downgrade an installed extension.
    if ([replacement.bundleVersion compare:existing.bundleVersion options:NSNumericSearch] == NSOrderedAscending) return OSSystemExtensionReplacementActionCancel;
    update(@"activating", @{@"message": @"正在更新虚拟摄像头…"});
    return OSSystemExtensionReplacementActionReplace;
}
- (void)request:(OSSystemExtensionRequest *)request didFinishWithResult:(OSSystemExtensionRequestResult)result {
    @synchronized(SFActivation.class) { pending = NO; }
    update(result == OSSystemExtensionRequestCompleted ? @"activated" : @"reboot_required", @{@"message": result == OSSystemExtensionRequestCompleted ? @"安装完成，正在检查…" : @"需要重启电脑才能装好。"});
}
- (void)request:(OSSystemExtensionRequest *)request didFailWithError:(NSError *)error {
    @synchronized(SFActivation.class) { pending = NO; }
    update(@"error", @{@"domain": error.domain, @"code": @(error.code), @"message": error.localizedDescription ?: @"系统没有允许安装虚拟摄像头，请到系统设置里允许后再试。"});
}
@end

static napi_value json(napi_env env, NSDictionary *object) {
    NSData *data = [NSJSONSerialization dataWithJSONObject:object options:0 error:nil];
    napi_value result;
    napi_create_string_utf8(env, (const char *)data.bytes, data.length, &result);
    return result;
}
static NSDictionary *signing(NSString *path) {
    SecStaticCodeRef code = NULL; CFDictionaryRef info = NULL;
    if (SecStaticCodeCreateWithPath((__bridge CFURLRef)[NSURL fileURLWithPath:path], kSecCSDefaultFlags, &code) != errSecSuccess) return @{};
    SecCodeCopySigningInformation(code, kSecCSSigningInformation, &info); CFRelease(code);
    return info ? CFBridgingRelease(info) : @{};
}
static napi_value inspect(napi_env env, napi_callback_info args) {
    @autoreleasepool {
        NSBundle *app = NSBundle.mainBundle;
        NSString *extension = [app.bundlePath stringByAppendingPathComponent:@"Contents/Library/SystemExtensions/app.soundface.camera.systemextension"];
        NSDictionary *host = signing(app.bundlePath), *child = signing(extension);
        NSDictionary *entitlements = host[(__bridge NSString *)kSecCodeInfoEntitlementsDict] ?: @{};
        return json(env, @{@"appPath": app.bundlePath ?: @"", @"team": host[(__bridge NSString *)kSecCodeInfoTeamIdentifier] ?: @"", @"extensionTeam": child[(__bridge NSString *)kSecCodeInfoTeamIdentifier] ?: @"", @"installEntitlement": @([entitlements[@"com.apple.developer.system-extension.install"] boolValue]), @"extensionExists": @([NSFileManager.defaultManager fileExistsAtPath:extension])});
    }
}
static napi_value status(napi_env env, napi_callback_info args) {
    @synchronized(SFActivation.class) { return json(env, state ?: @{@"phase": @"idle"}); }
}
static napi_value activate(napi_env env, napi_callback_info args) {
    @synchronized(SFActivation.class) {
        if (pending) return json(env, state);
        if (![NSBundle.mainBundle.bundleIdentifier isEqualToString:@"app.soundface.desktop"]) {
            update(@"error", @{@"message": @"请先把 SoundFace 拖进“应用程序”文件夹，从那里打开再安装。"});
            return json(env, state);
        }
        pending = YES; update(@"activating", @{@"message": @"正在安装虚拟摄像头…"});
    }
    dispatch_async(dispatch_get_main_queue(), ^{
        delegate = [SFActivation new];
        OSSystemExtensionRequest *request = [OSSystemExtensionRequest activationRequestForExtension:@"app.soundface.camera" queue:dispatch_get_main_queue()];
        request.delegate = delegate;
        [OSSystemExtensionManager.sharedManager submitRequest:request];
    });
    return status(env, args);
}
static napi_value init(napi_env env, napi_value exports) {
    napi_property_descriptor properties[] = {
        {"inspect", NULL, inspect, NULL, NULL, NULL, napi_default, NULL},
        {"status", NULL, status, NULL, NULL, NULL, napi_default, NULL},
        {"activate", NULL, activate, NULL, NULL, NULL, napi_default, NULL}
    };
    napi_define_properties(env, exports, 3, properties); return exports;
}
NAPI_MODULE(NODE_GYP_MODULE_NAME, init)
