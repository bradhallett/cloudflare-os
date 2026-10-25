// Type text-loader imports such as the bundled app HTML and the agent-facing types.
declare module "*.txt" {
  const content: string;
  export default content;
}
