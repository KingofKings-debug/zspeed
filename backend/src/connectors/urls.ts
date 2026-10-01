export function getOemBaseUrl(oemId: string): string {
  const simulatorUrl = `http://127.0.0.1:${process.env.SIMULATOR_PORT || "3002"}`;
  switch (oemId) {
    case "oem_voltera":
      return process.env.VOLTERA_BASE_URL || `${simulatorUrl}/oem/voltera`;
    case "oem_crestline":
      return process.env.CRUX_BASE_URL || process.env.CRESTLINE_BASE_URL || `${simulatorUrl}/oem/crestline`;
    case "oem_navarro":
      return process.env.NAVARRO_BASE_URL || `${simulatorUrl}/oem/navarro`;
    default:
      return simulatorUrl;
  }
}
