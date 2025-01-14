import { DocumentNode, EnumTypeDefinitionNode, parse } from 'graphql';
import { process } from '@graphql-mesh/cross-helpers';
import { PredefinedProxyOptions, StoreProxy } from '@graphql-mesh/store';
import {
  getInterpolatedHeadersFactory,
  getInterpolatedStringFactory,
  ResolverData,
  stringInterpolator,
} from '@graphql-mesh/string-interpolation';
import {
  GetMeshSourcePayload,
  ImportFn,
  Logger,
  MeshFetch,
  MeshHandler,
  MeshHandlerOptions,
  MeshSource,
  YamlConfig,
} from '@graphql-mesh/types';
import { isUrl, readFile, readUrl } from '@graphql-mesh/utils';
import { buildHTTPExecutor, HTTPExecutorOptions } from '@graphql-tools/executor-http';
import { getStitchedSchemaFromSupergraphSdl } from '@graphql-tools/federation';

export default class SupergraphHandler implements MeshHandler {
  private config: YamlConfig.Handler['supergraph'];
  private baseDir: string;
  private supergraphSdl: StoreProxy<DocumentNode>;
  private importFn: ImportFn;
  private fetchFn: MeshFetch;
  private logger: Logger;

  constructor({
    config,
    baseDir,
    store,
    importFn,
    logger,
  }: MeshHandlerOptions<YamlConfig.Handler['supergraph']>) {
    this.config = config;
    this.baseDir = baseDir;
    this.supergraphSdl = store.proxy(
      'nonExecutableSchema',
      PredefinedProxyOptions.JsonWithoutValidation,
    );
    this.importFn = importFn;
    this.logger = logger;
  }

  private async getSupergraphSdl(): Promise<DocumentNode> {
    const schemaHeadersFactory = getInterpolatedHeadersFactory(this.config.schemaHeaders);
    const interpolatedSource = stringInterpolator.parse(this.config.source, {
      env: process.env,
    });
    if (isUrl(interpolatedSource)) {
      const res = await readUrl<DocumentNode | string>(interpolatedSource, {
        headers: schemaHeadersFactory({
          env: process.env,
        }),
        cwd: this.baseDir,
        allowUnknownExtensions: true,
        importFn: this.importFn,
        fetch: this.fetchFn,
        logger: this.logger,
      }).catch(e => {
        throw new Error(`Failed to load supergraph SDL from ${interpolatedSource}:\n ${e.message}`);
      });
      return handleSupergraphResponse(res, interpolatedSource);
    }
    return this.supergraphSdl.getWithSet(async () => {
      const sdlOrIntrospection = await readFile<string | DocumentNode>(interpolatedSource, {
        headers: schemaHeadersFactory({
          env: process.env,
        }),
        cwd: this.baseDir,
        allowUnknownExtensions: true,
        importFn: this.importFn,
        fetch: this.fetchFn,
        logger: this.logger,
      }).catch(e => {
        throw new Error(`Failed to load supergraph SDL from ${interpolatedSource}:\n ${e.message}`);
      });
      return handleSupergraphResponse(sdlOrIntrospection, interpolatedSource);
    });
  }

  async getMeshSource({ fetchFn }: GetMeshSourcePayload): Promise<MeshSource> {
    const subgraphConfigs = this.config.subgraphs || [];
    this.fetchFn = fetchFn;
    const supergraphSdl = await this.getSupergraphSdl();
    const operationHeadersFactory =
      this.config.operationHeaders != null
        ? getInterpolatedHeadersFactory(this.config.operationHeaders)
        : undefined;
    const joingraphEnum = supergraphSdl.definitions.find(
      def => def.kind === 'EnumTypeDefinition' && def.name.value === 'join__Graph',
    ) as EnumTypeDefinitionNode;
    const subgraphNameIdMap = new Map<string, string>();
    if (joingraphEnum) {
      joingraphEnum.values?.forEach(value => {
        value.directives?.forEach(directive => {
          if (directive.name.value === 'join__graph') {
            const nameArg = directive.arguments?.find(arg => arg.name.value === 'name');
            if (nameArg?.value?.kind === 'StringValue') {
              subgraphNameIdMap.set(value.name.value, nameArg.value.value);
            }
          }
        });
      });
    }
    const schema = getStitchedSchemaFromSupergraphSdl({
      supergraphSdl,
      onSubschemaConfig(subgraphConfig) {
        let { name: subgraphName, endpoint: nonInterpolatedEndpoint } = subgraphConfig;
        const subgraphRealName = subgraphNameIdMap.get(subgraphName);
        const subgraphConfiguration: YamlConfig.SubgraphConfiguration = subgraphConfigs.find(
          subgraphConfig => subgraphConfig.name === subgraphRealName,
        ) || {
          name: subgraphName,
        };
        nonInterpolatedEndpoint = subgraphConfiguration.endpoint || nonInterpolatedEndpoint;
        const endpointFactory = getInterpolatedStringFactory(nonInterpolatedEndpoint);
        subgraphConfig.executor = buildHTTPExecutor({
          ...(subgraphConfiguration as any),
          endpoint: nonInterpolatedEndpoint,
          fetch(url: string, init: any, context: any, info: any) {
            const endpoint = endpointFactory({
              env: process.env,
              context,
              info,
            });
            url = url.replace(nonInterpolatedEndpoint, endpoint);
            return fetchFn(url, init, context, info);
          },
          headers(executorRequest) {
            const headers = {};
            const resolverData: ResolverData = {
              root: executorRequest.rootValue,
              env: process.env,
              context: executorRequest.context,
              info: executorRequest.info,
              args: executorRequest.variables,
            };
            if (subgraphConfiguration?.operationHeaders) {
              const headersFactory = getInterpolatedHeadersFactory(
                subgraphConfiguration.operationHeaders,
              );
              Object.assign(headers, headersFactory(resolverData));
            }
            if (operationHeadersFactory) {
              Object.assign(headers, operationHeadersFactory(resolverData));
            }
            return headers;
          },
        } as HTTPExecutorOptions);
      },
      batch: this.config.batch == null ? true : this.config.batch,
    });
    return {
      schema,
    };
  }
}

function handleSupergraphResponse(
  sdlOrDocumentNode: string | DocumentNode,
  interpolatedSource: string,
) {
  if (typeof sdlOrDocumentNode === 'string') {
    try {
      return parse(sdlOrDocumentNode, { noLocation: true });
    } catch (e) {
      throw new Error(
        `Supergraph source must be a valid GraphQL SDL string or a parsed DocumentNode, but got an invalid result from ${interpolatedSource} instead.\n Got result: ${sdlOrDocumentNode}\n Got error: ${e.message}`,
      );
    }
  }
  if (sdlOrDocumentNode?.kind !== 'Document') {
    throw new Error(
      `Supergraph source must be a valid GraphQL SDL string or a parsed DocumentNode, but got an invalid result from ${interpolatedSource} instead.\n Got result: ${JSON.stringify(sdlOrDocumentNode, null, 2)}`,
    );
  }
  return sdlOrDocumentNode;
}
