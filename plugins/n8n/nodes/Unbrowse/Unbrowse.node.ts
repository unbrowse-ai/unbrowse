import type {
	IDataObject,
	IExecuteFunctions,
	IHttpRequestOptions,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
	JsonObject,
} from 'n8n-workflow';
import { NodeApiError, NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';

const MCP_URL = 'https://unbrowse.ai/api/mcp';

type ToolResult = {
	content?: Array<{ type?: string; text?: string }>;
	structuredContent?: unknown;
	isError?: boolean;
};

type RpcResponse = {
	result?: ToolResult;
	error?: { code?: number; message?: string };
};

function decodeResult(result: ToolResult | undefined): IDataObject {
	const texts = (result?.content ?? [])
		.filter((part) => part?.type === 'text' && typeof part.text === 'string')
		.map((part) => part.text as string);
	if (texts.length === 0) {
		const structured = result?.structuredContent;
		if (structured && typeof structured === 'object' && !Array.isArray(structured)) {
			return structured as IDataObject;
		}
		return { result: (structured as IDataObject) ?? null };
	}
	const text = texts.join('\n');
	try {
		const parsed: unknown = JSON.parse(text);
		if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as IDataObject;
		return { result: parsed as IDataObject };
	} catch {
		return { text };
	}
}

export class Unbrowse implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Unbrowse',
		name: 'unbrowse',
		icon: { light: 'file:unbrowse.svg', dark: 'file:unbrowse.dark.svg' },
		group: ['transform'],
		version: 1,
		subtitle: '={{$parameter["operation"]}}',
		description: 'Turn websites into APIs: scrape pages, discover learned site APIs and run site tasks',
		defaults: {
			name: 'Unbrowse',
		},
		usableAsTool: true,
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
		credentials: [
			{
				name: 'unbrowseApi',
				required: true,
			},
		],
		properties: [
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				options: [
					{
						name: 'Discover',
						value: 'discover',
						description: 'Find site APIs Unbrowse has already learned for a goal',
						action: 'Discover learned site tools',
					},
					{
						name: 'Run Task',
						value: 'runTask',
						description: 'Do a website task in one call and get structured JSON back',
						action: 'Run a website task',
					},
					{
						name: 'Scrape Page',
						value: 'scrapePage',
						description: 'Read a web page as clean markdown with its metadata and links',
						action: 'Scrape a page',
					},
				],
				default: 'scrapePage',
			},
			{
				displayName: 'URL',
				name: 'url',
				type: 'string',
				required: true,
				default: '',
				placeholder: 'https://example.com',
				description: 'The page to read',
				displayOptions: { show: { operation: ['scrapePage'] } },
			},
			{
				displayName: 'Options',
				name: 'scrapeOptions',
				type: 'collection',
				placeholder: 'Add Option',
				default: {},
				displayOptions: { show: { operation: ['scrapePage'] } },
				options: [
					{
						displayName: 'Formats',
						name: 'formats',
						type: 'multiOptions',
						options: [
							{ name: 'HTML', value: 'html' },
							{ name: 'Links', value: 'links' },
							{ name: 'Markdown', value: 'markdown' },
							{ name: 'Raw', value: 'raw' },
							{ name: 'Text', value: 'text' },
						],
						default: ['markdown'],
						description: 'What to return. Raw returns the response body as sent (JSON APIs, feeds).',
					},
					{
						displayName: 'Only Main Content',
						name: 'onlyMainContent',
						type: 'boolean',
						default: true,
						description: 'Whether to drop navigation, headers, footers and asides',
					},
					{
						displayName: 'Render',
						name: 'render',
						type: 'options',
						options: [
							{
								name: 'Auto',
								value: 'auto',
								description: 'Plain HTTP first, a browser only if the page needs one',
							},
							{ name: 'Always', value: 'always', description: 'Always use a cloud browser' },
							{ name: 'Never', value: 'never', description: 'HTTP only' },
						],
						default: 'auto',
					},
				],
			},
			{
				displayName: 'Query',
				name: 'query',
				type: 'string',
				required: true,
				default: '',
				placeholder: 'hacker news top stories',
				description: 'The goal or site to find learned APIs for, in plain language',
				displayOptions: { show: { operation: ['discover'] } },
			},
			{
				displayName: 'Task',
				name: 'task',
				type: 'string',
				default: '',
				placeholder: 'get the top stories on hacker news',
				description: 'The website task in plain language. Required unless you set a capability ID.',
				displayOptions: { show: { operation: ['runTask'] } },
			},
			{
				displayName: 'Additional Fields',
				name: 'runOptions',
				type: 'collection',
				placeholder: 'Add Field',
				default: {},
				displayOptions: { show: { operation: ['runTask'] } },
				options: [
					{
						displayName: 'Capability ID',
						name: 'capability',
						type: 'string',
						default: '',
						description: 'A capability ID returned by Discover, to run that exact site API',
					},
					{
						displayName: 'Input',
						name: 'input',
						type: 'json',
						default: '{}',
						description:
							'Inputs for the task as a JSON object, e.g. {"query": "laptops"}. Use it to answer an input_required status.',
					},
				],
			},
		],
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const returnData: INodeExecutionData[] = [];

		for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
			try {
				const operation = this.getNodeParameter('operation', itemIndex) as string;
				let tool: string;
				let args: IDataObject;
				let timeout = 120000;

				if (operation === 'scrapePage') {
					const url = (this.getNodeParameter('url', itemIndex) as string).trim();
					if (!/^https?:\/\//i.test(url)) {
						throw new NodeOperationError(this.getNode(), 'URL must start with http:// or https://', {
							itemIndex,
						});
					}
					const options = this.getNodeParameter('scrapeOptions', itemIndex, {}) as IDataObject;
					tool = 'unbrowse.scrape';
					args = { url };
					const formats = options.formats as string[] | undefined;
					args.formats = formats && formats.length > 0 ? formats : ['markdown'];
					if (options.onlyMainContent !== undefined) args.onlyMainContent = options.onlyMainContent;
					if (options.render) args.render = options.render;
				} else if (operation === 'discover') {
					const query = (this.getNodeParameter('query', itemIndex) as string).trim();
					if (!query) {
						throw new NodeOperationError(this.getNode(), 'Query is required', { itemIndex });
					}
					tool = 'unbrowse.discover';
					args = { query };
					timeout = 60000;
				} else if (operation === 'runTask') {
					const task = (this.getNodeParameter('task', itemIndex, '') as string).trim();
					const options = this.getNodeParameter('runOptions', itemIndex, {}) as IDataObject;
					const capability = ((options.capability as string) ?? '').trim();
					if (!task && !capability) {
						throw new NodeOperationError(
							this.getNode(),
							'Set a task (plain language) or a capability ID from Discover',
							{ itemIndex },
						);
					}
					tool = 'unbrowse.run';
					args = {};
					if (task) args.task = task;
					if (capability) args.capability = capability;
					let input: unknown = options.input;
					if (typeof input === 'string') {
						const trimmed = input.trim();
						if (trimmed) {
							try {
								input = JSON.parse(trimmed);
							} catch {
								throw new NodeOperationError(this.getNode(), 'Input must be a JSON object', {
									itemIndex,
								});
							}
						} else {
							input = undefined;
						}
					}
					if (input !== undefined) {
						if (!input || typeof input !== 'object' || Array.isArray(input)) {
							throw new NodeOperationError(this.getNode(), 'Input must be a JSON object', { itemIndex });
						}
						if (Object.keys(input as object).length > 0) args.input = input as IDataObject;
					}
					timeout = 240000;
				} else {
					throw new NodeOperationError(this.getNode(), `Unknown operation: ${operation}`, { itemIndex });
				}

				const request: IHttpRequestOptions = {
					method: 'POST',
					url: MCP_URL,
					headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
					body: {
						jsonrpc: '2.0',
						id: itemIndex + 1,
						method: 'tools/call',
						params: { name: tool, arguments: args },
					},
					json: true,
					timeout,
				};

				const response = (await this.helpers.httpRequestWithAuthentication.call(
					this,
					'unbrowseApi',
					request,
				)) as RpcResponse;

				if (response?.error) {
					throw new NodeOperationError(
						this.getNode(),
						`Unbrowse error: ${response.error.message ?? 'request failed'}`,
						{ itemIndex },
					);
				}
				const data = decodeResult(response?.result);
				if (response?.result?.isError) {
					throw new NodeOperationError(
						this.getNode(),
						`Unbrowse error: ${typeof data.text === 'string' ? data.text : JSON.stringify(data)}`,
						{ itemIndex },
					);
				}
				returnData.push({ json: data, pairedItem: { item: itemIndex } });
			} catch (error) {
				if (this.continueOnFail()) {
					returnData.push({
						json: { error: (error as Error).message },
						pairedItem: { item: itemIndex },
					});
					continue;
				}
				if (error instanceof NodeOperationError) {
					throw new NodeOperationError(this.getNode(), error, { itemIndex });
				}
				throw new NodeApiError(this.getNode(), error as JsonObject, { itemIndex });
			}
		}

		return [returnData];
	}
}
