import type {
	IAuthenticateGeneric,
	Icon,
	ICredentialTestRequest,
	ICredentialType,
	INodeProperties,
} from 'n8n-workflow';

export class UnbrowseApi implements ICredentialType {
	name = 'unbrowseApi';

	displayName = 'Unbrowse API';

	icon: Icon = { light: 'file:unbrowse.svg', dark: 'file:unbrowse.dark.svg' };

	documentationUrl = 'https://github.com/unbrowse-ai/unbrowse/tree/main/plugins/n8n#credentials';

	properties: INodeProperties[] = [
		{
			displayName: 'API Key',
			name: 'apiKey',
			type: 'string',
			typeOptions: { password: true },
			required: true,
			default: '',
			placeholder: 'ub_live_...',
			description: 'Your Unbrowse API key. Create a free one at https://unbrowse.ai/app.',
		},
	];

	authenticate: IAuthenticateGeneric = {
		type: 'generic',
		properties: {
			headers: {
				Authorization: '=Bearer {{$credentials.apiKey}}',
			},
		},
	};

	test: ICredentialTestRequest = {
		request: {
			baseURL: 'https://unbrowse.ai',
			url: '/api/mcp',
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Accept: 'application/json',
			},
			body: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
		},
	};
}
