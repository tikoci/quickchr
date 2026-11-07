// vmnet privilege probe: legacy vs macOS 26 network-object API, shared/host/bridged
#include <vmnet/vmnet.h>
#include <dispatch/dispatch.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>
#include <arpa/inet.h>

static dispatch_queue_t q;

static int start_legacy(operating_modes_t mode, const char *iface) {
  xpc_object_t d = xpc_dictionary_create(NULL, NULL, 0);
  xpc_dictionary_set_uint64(d, vmnet_operation_mode_key, mode);
  if (iface) xpc_dictionary_set_string(d, vmnet_shared_interface_name_key, iface);
  dispatch_semaphore_t s = dispatch_semaphore_create(0);
  __block vmnet_return_t rc = -1;
  interface_ref i = vmnet_start_interface(d, q, ^(vmnet_return_t st, xpc_object_t p) {
    rc = st;
    if (st == VMNET_SUCCESS && p) {
      const char *a = xpc_dictionary_get_string(p, vmnet_start_address_key);
      const char *m = xpc_dictionary_get_string(p, vmnet_mac_address_key);
      printf("    start addr=%s mac=%s\n", a ? a : "-", m ? m : "-");
    }
    dispatch_semaphore_signal(s);
  });
  dispatch_semaphore_wait(s, dispatch_time(DISPATCH_TIME_NOW, 10LL * NSEC_PER_SEC));
  if (i && rc == VMNET_SUCCESS) {
    dispatch_semaphore_t s2 = dispatch_semaphore_create(0);
    vmnet_stop_interface(i, q, ^(vmnet_return_t st) { dispatch_semaphore_signal(s2); });
    dispatch_semaphore_wait(s2, DISPATCH_TIME_FOREVER);
  }
  return rc;
}

static int start_new(vmnet_mode_t mode, const char *ext, int serialize) {
  vmnet_return_t st = 0;
  vmnet_network_configuration_ref c = vmnet_network_configuration_create(mode, &st);
  if (!c) { printf("    config_create status=%d\n", st); return st; }
  if (ext) {
    vmnet_return_t e = vmnet_network_configuration_set_external_interface(c, ext);
    printf("    set_external_interface(%s)=%d\n", ext, e);
  }
  vmnet_network_ref n = vmnet_network_create(c, &st);
  if (!n) { printf("    network_create status=%d\n", st); return st; }
  struct in_addr sub, mask; vmnet_network_get_ipv4_subnet(n, &sub, &mask);
  char sb[32], mb[32]; inet_ntop(AF_INET, &sub, sb, sizeof sb); inet_ntop(AF_INET, &mask, mb, sizeof mb);
  printf("    network_create OK subnet=%s mask=%s\n", sb, mb);
  if (serialize) {
    xpc_object_t ser = vmnet_network_copy_serialization(n, &st);
    printf("    copy_serialization %s status=%d\n", ser ? "OK" : "FAIL", st);
    if (ser) { char *desc = xpc_copy_description(ser); printf("    ser=%.300s\n", desc); }
  }
  xpc_object_t d = xpc_dictionary_create(NULL, NULL, 0);
  dispatch_semaphore_t s = dispatch_semaphore_create(0);
  __block vmnet_return_t rc = -1;
  interface_ref i = vmnet_interface_start_with_network(n, d, q, ^(vmnet_return_t s2, xpc_object_t p) {
    rc = s2;
    if (s2 == VMNET_SUCCESS && p) {
      const char *m = xpc_dictionary_get_string(p, vmnet_mac_address_key);
      printf("    iface start OK mac=%s\n", m ? m : "-");
    }
    dispatch_semaphore_signal(s);
  });
  dispatch_semaphore_wait(s, dispatch_time(DISPATCH_TIME_NOW, 10LL * NSEC_PER_SEC));
  printf("    interface_start_with_network handle=%s status=%d\n", i ? "non-null" : "NULL", rc);
  if (i && rc == VMNET_SUCCESS) {
    dispatch_semaphore_t s3 = dispatch_semaphore_create(0);
    vmnet_stop_interface(i, q, ^(vmnet_return_t x) { dispatch_semaphore_signal(s3); });
    dispatch_semaphore_wait(s3, DISPATCH_TIME_FOREVER);
  }
  return rc;
}

int main(int argc, char **argv) {
  q = dispatch_queue_create("probe", DISPATCH_QUEUE_SERIAL);
  printf("euid=%d\n", geteuid());
  xpc_object_t l = vmnet_copy_shared_interface_list();
  if (l) { char *d = xpc_copy_description(l); printf("bridgeable: %s\n", d); }
  const char *br = argc > 1 ? argv[1] : "en0";
  printf("legacy SHARED:  rc=%d\n", start_legacy(VMNET_SHARED_MODE, NULL));
  printf("legacy HOST:    rc=%d\n", start_legacy(VMNET_HOST_MODE, NULL));
  printf("legacy BRIDGED(%s): rc=%d\n", br, start_legacy(VMNET_BRIDGED_MODE, br));
  printf("new SHARED:\n"); printf("  rc=%d\n", start_new(VMNET_SHARED_MODE, NULL, 1));
  printf("new HOST:\n");   printf("  rc=%d\n", start_new(VMNET_HOST_MODE, NULL, 0));
  printf("new SHARED ext=%s:\n", br); printf("  rc=%d\n", start_new(VMNET_SHARED_MODE, br, 0));
  printf("new BRIDGED (expect unsupported):\n"); printf("  rc=%d\n", start_new(VMNET_BRIDGED_MODE, NULL, 0));
  return 0;
}
