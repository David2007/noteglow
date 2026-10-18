export const MAX_IMAGES = 4;
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_IMAGE_TOTAL_BYTES = 20 * 1024 * 1024;
const MAX_IMAGE_PIXELS = 32_000_000;

export interface ImageAttachment {
  id: string;
  name: string;
  fileName: string;
  mime: "image/png" | "image/jpeg" | "image/webp";
  size: number;
  width: number;
  height: number;
  sha256: string;
}

export function validateImages(images: readonly ImageAttachment[]): string | null {
  if (images.length > MAX_IMAGES) return "每条消息最多添加 4 张图片。";
  let total = 0;
  for (const image of images) {
    if (!isImageAttachment(image)) return "图片附件信息不完整，请重新添加图片。";
    total += image.size;
  }
  return total > MAX_IMAGE_TOTAL_BYTES ? "图片合计超过 20 MiB，请移除部分图片。" : null;
}

// 持久化文件只允许随机文件名，不能把损坏或手改的 JSON 当任意本机文件路径。
export function isImageAttachment(value: unknown): value is ImageAttachment {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const image = value as Record<string, unknown>;
  const extension = image.mime === "image/png" ? "png" : image.mime === "image/jpeg" ? "jpg" : image.mime === "image/webp" ? "webp" : null;
  return extension !== null && typeof image.id === "string" && /^[a-f0-9-]{36}$/.test(image.id)
    && image.fileName === `${image.id}.${extension}`
    && typeof image.name === "string" && image.name.length > 0 && image.name.length <= 200 && !/[\x00-\x1f\x7f]/.test(image.name)
    && typeof image.sha256 === "string" && /^[a-f0-9]{64}$/.test(image.sha256)
    && typeof image.size === "number" && Number.isInteger(image.size) && image.size > 0 && image.size <= MAX_IMAGE_BYTES
    && typeof image.width === "number" && typeof image.height === "number" && validDimensions(image.width, image.height);
}

export function parseImages(raw: unknown): ImageAttachment[] {
  if (!Array.isArray(raw)) return [];
  const result: ImageAttachment[] = [];
  for (const value of raw) {
    if (isImageAttachment(value) && !validateImages([...result, value])) result.push({ ...value });
  }
  return result;
}

// 先核验真实文件头及像素预算，再允许缩略图解码；不信任扩展名或剪贴板 MIME。
export function inspectImage(bytes: Uint8Array): Pick<ImageAttachment, "mime" | "width" | "height"> {
  if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) throw new Error("图片为空或超过单张 10 MiB 限制。");
  const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ascii = (offset: number, size: number): string => String.fromCharCode(...bytes.subarray(offset, offset + size));
  let mime: ImageAttachment["mime"], width = 0, height = 0;
  if (bytes.length >= 33 && bytes[0] === 137 && ascii(1, 7) === "PNG\r\n\x1a\n" && ascii(12, 4) === "IHDR") {
    mime = "image/png"; width = data.getUint32(16); height = data.getUint32(20);
  } else if (bytes.length >= 12 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    mime = "image/jpeg";
    let offset = 2;
    while (offset + 4 <= bytes.length) {
      if (bytes[offset++] !== 0xff) break;
      while (offset < bytes.length && bytes[offset] === 0xff) offset++;
      const marker = bytes[offset++];
      if (marker === 0xda || marker === 0xd9 || offset + 2 > bytes.length) break;
      const length = data.getUint16(offset);
      if (length < 2 || offset + length > bytes.length) break;
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker) && length >= 8) {
        height = data.getUint16(offset + 3); width = data.getUint16(offset + 5); break;
      }
      offset += length;
    }
  } else if (bytes.length >= 30 && ascii(0, 4) === "RIFF" && ascii(8, 4) === "WEBP" && data.getUint32(4, true) + 8 <= bytes.length) {
    mime = "image/webp";
    const chunk = ascii(12, 4);
    if (chunk === "VP8X") {
      if (bytes[20] & 2) throw new Error("暂不支持动画 WebP，请导出为静态图片。");
      width = 1 + bytes[24] + (bytes[25] << 8) + (bytes[26] << 16);
      height = 1 + bytes[27] + (bytes[28] << 8) + (bytes[29] << 16);
    } else if (chunk === "VP8L" && bytes[20] === 0x2f) {
      const bits = data.getUint32(21, true);
      width = (bits & 0x3fff) + 1; height = ((bits >>> 14) & 0x3fff) + 1;
    } else if (chunk === "VP8 " && ascii(23, 3) === "\x9d\x01\x2a") {
      width = data.getUint16(26, true) & 0x3fff; height = data.getUint16(28, true) & 0x3fff;
    }
  } else throw new Error("仅支持 PNG、JPEG 和静态 WebP 图片，请先转换图片格式。");
  if (!validDimensions(width, height)) throw new Error("图片尺寸无效或超过 3200 万像素，请缩小后重试。");
  return { mime, width, height };
}

function validDimensions(width: number, height: number): boolean {
  return Number.isInteger(width) && Number.isInteger(height) && width > 0 && height > 0
    && width <= 16384 && height <= 16384 && width * height <= MAX_IMAGE_PIXELS;
}
