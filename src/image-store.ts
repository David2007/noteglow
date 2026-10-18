import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";
import { inspectImage, isImageAttachment, validateImages, type ImageAttachment } from "./image-attachments.ts";

export interface PreparedImages { paths: string[]; dispose: () => Promise<void>; }

export class ImageStore {
  private readonly directory: string;
  private readonly vault: string;
  private readonly pluginDirectory: string;
  constructor(vault: string, pluginDirectory: string) {
    this.vault = vault;
    this.pluginDirectory = pluginDirectory;
    this.directory = resolve(vault, pluginDirectory, "image-attachments");
    if (isAbsolute(pluginDirectory) || pluginDirectory.split(/[\\/]/).some((part) => !part || part === ".." || part === ".")
      || !this.directory.startsWith(resolve(vault) + sep)) throw new Error("图片缓存目录必须位于当前 Vault 内。");
  }

  async add(name: string, bytes: Uint8Array): Promise<ImageAttachment> {
    const inspected = inspectImage(bytes);
    const id = randomUUID();
    const extension = inspected.mime === "image/png" ? "png" : inspected.mime === "image/jpeg" ? "jpg" : "webp";
    const attachment: ImageAttachment = {
      id, name: name.replace(/[\\/\x00-\x1f\x7f]/g, "_").slice(0, 200) || `图片.${extension}`,
      fileName: `${id}.${extension}`, ...inspected, size: bytes.length, sha256: hash(bytes)
    };
    await this.checkedDirectory();
    // 原文件只在用户选择时读取一次，草稿与历史指向私有副本；不保存原绝对路径或 base64。
    await writeFile(join(this.directory, attachment.fileName), bytes, { flag: "wx", mode: 0o600 });
    return attachment;
  }

  async verify(attachment: ImageAttachment): Promise<Uint8Array> {
    if (!isImageAttachment(attachment)) throw new Error("图片引用已损坏，请重新添加。");
    await this.checkedDirectory();
    const path = join(this.directory, attachment.fileName);
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== attachment.size || await realpath(path) !== path) {
      throw new Error(`图片缓存已变化，请重新添加：${attachment.name}`);
    }
    const bytes = await readFile(path);
    if (bytes.length !== attachment.size || hash(bytes) !== attachment.sha256) throw new Error(`图片内容已变化，请重新添加：${attachment.name}`);
    const inspected = inspectImage(bytes);
    if (inspected.mime !== attachment.mime || inspected.width !== attachment.width || inspected.height !== attachment.height) throw new Error("图片元数据与内容不一致。");
    return bytes;
  }

  async resourcePath(attachment: ImageAttachment): Promise<string> {
    await this.verify(attachment);
    return `${this.pluginDirectory}/image-attachments/${attachment.fileName}`.replace(/\\/g, "/");
  }

  async prepare(images: readonly ImageAttachment[]): Promise<PreparedImages> {
    const error = validateImages(images);
    if (error) throw new Error(error);
    if (!images.length) return { paths: [], dispose: async () => undefined };
    const directory = await mkdtemp(join(tmpdir(), "noteglow-images-"));
    const dispose = async (): Promise<void> => { await rm(directory, { recursive: true, force: true }); };
    const paths: string[] = [];
    try {
      for (const image of images) {
        const bytes = await this.verify(image);
        const path = join(directory, image.fileName);
        // CLI 只读本轮已核验的快照，不受稍后 Vault 内编辑或同步改图影响。
        await writeFile(path, bytes, { flag: "wx", mode: 0o600 });
        paths.push(path);
      }
      return { paths, dispose };
    } catch (error) { await dispose(); throw error; }
  }

  private async checkedDirectory(): Promise<void> {
    const vault = await realpath(this.vault);
    // 先核验已存在的插件目录，再建子目录，避免沿着被替换的父级符号链接写出 Vault。
    if (await realpath(resolve(this.vault, this.pluginDirectory)) !== join(vault, this.pluginDirectory)) {
      throw new Error("插件目录包含符号链接，未读写图片。");
    }
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    if (await realpath(this.directory) !== join(vault, this.pluginDirectory, "image-attachments")) {
      throw new Error("图片缓存目录包含符号链接，未读写图片。");
    }
  }
}

function hash(bytes: Uint8Array): string { return createHash("sha256").update(bytes).digest("hex"); }
