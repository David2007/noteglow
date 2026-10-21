// 该依赖只通过 exports 提供类型；保留仓库现有 node 模块解析方式。
declare module "prettier-plugin-java" {
  const plugin: import("prettier").Plugin;
  export default plugin;
}
