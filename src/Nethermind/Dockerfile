# See https://aka.ms/customizecontainer to learn how to customize your debug container and how Visual Studio uses this Dockerfile to build your images for faster debugging.
# This stage is used when running from VS in fast mode (Default for Debug configuration)
FROM mcr.microsoft.com/dotnet/aspnet:9.0 AS base
USER $APP_UID
WORKDIR /app
EXPOSE 8545 8551 30303
# This stage is used to build the service project
FROM mcr.microsoft.com/dotnet/sdk:9.0 AS build
ARG BUILD_CONFIGURATION=Release
WORKDIR /src
# Copy each *.csproj so Docker can cache the restore step
COPY ["Nethermind.Runner/Nethermind.Runner.csproj", "Nethermind.Runner/"]
COPY ["Nethermind.Blockchain/Nethermind.Blockchain.csproj", "Nethermind.Blockchain/"]
COPY ["Nethermind.Api/Nethermind.Api.csproj", "Nethermind.Api/"]
COPY ["Nethermind.Flashbots/Nethermind.Flashbots.csproj", "Nethermind.Flashbots/"]
COPY ["Nethermind.Consensus.AuRa/Nethermind.Consensus.AuRa.csproj", "Nethermind.Consensus.AuRa/"]
COPY ["Nethermind.Consensus.Clique/Nethermind.Consensus.Clique.csproj", "Nethermind.Consensus.Clique/"]
COPY ["Nethermind.Consensus.Ethash/Nethermind.Consensus.Ethash.csproj", "Nethermind.Consensus.Ethash/"]
COPY ["Nethermind.Core/Nethermind.Core.csproj", "Nethermind.Core/"]
COPY ["Nethermind.Db/Nethermind.Db.csproj", "Nethermind.Db/"]
COPY ["Nethermind.Db.Rocks/Nethermind.Db.Rocks.csproj", "Nethermind.Db.Rocks/"]
COPY ["Nethermind.Db.Rpc/Nethermind.Db.Rpc.csproj", "Nethermind.Db.Rpc/"]
COPY ["Nethermind.EthStats/Nethermind.EthStats.csproj", "Nethermind.EthStats/"]
COPY ["Nethermind.ExternalSigner.Plugin/Nethermind.ExternalSigner.Plugin.csproj", "Nethermind.ExternalSigner.Plugin/"]
COPY ["Nethermind.Grpc/Nethermind.Grpc.csproj", "Nethermind.Grpc/"]
COPY ["Nethermind.HealthChecks/Nethermind.HealthChecks.csproj", "Nethermind.HealthChecks/"]
COPY ["Nethermind.Hive/Nethermind.Hive.csproj", "Nethermind.Hive/"]
COPY ["Nethermind.Init/Nethermind.Init.csproj", "Nethermind.Init/"]
COPY ["Nethermind.Init.Snapshot/Nethermind.Init.Snapshot.csproj", "Nethermind.Init.Snapshot/"]
COPY ["Nethermind.JsonRpc/Nethermind.JsonRpc.csproj", "Nethermind.JsonRpc/"]
COPY ["Nethermind.JsonRpc.TraceStore/Nethermind.JsonRpc.TraceStore.csproj", "Nethermind.JsonRpc.TraceStore/"]
COPY ["Nethermind.Logging.NLog/Nethermind.Logging.NLog.csproj", "Nethermind.Logging.NLog/"]
COPY ["Nethermind.Merge.AuRa/Nethermind.Merge.AuRa.csproj", "Nethermind.Merge.AuRa/"]
COPY ["Nethermind.Merge.Plugin/Nethermind.Merge.Plugin.csproj", "Nethermind.Merge.Plugin/"]
COPY ["Nethermind.Monitoring/Nethermind.Monitoring.csproj", "Nethermind.Monitoring/"]
COPY ["Nethermind.Network/Nethermind.Network.csproj", "Nethermind.Network/"]
COPY ["Nethermind.Optimism/Nethermind.Optimism.csproj", "Nethermind.Optimism/"]
COPY ["Nethermind.Taiko/Nethermind.Taiko.csproj", "Nethermind.Taiko/"]
COPY ["Nethermind.Seq/Nethermind.Seq.csproj", "Nethermind.Seq/"]
COPY ["Nethermind.Shutter/Nethermind.Shutter.csproj", "Nethermind.Shutter/"]
COPY ["Nethermind.Sockets/Nethermind.Sockets.csproj", "Nethermind.Sockets/"]
COPY ["Nethermind.Specs/Nethermind.Specs.csproj", "Nethermind.Specs/"]
COPY ["Nethermind.Synchronization/Nethermind.Synchronization.csproj", "Nethermind.Synchronization/"]
COPY ["Nethermind.UPnP.Plugin/Nethermind.UPnP.Plugin.csproj", "Nethermind.UPnP.Plugin/"]
RUN dotnet restore "/Nethermind.Runner/Nethermind.Runner.csproj"
COPY . .
WORKDIR "/src/Nethermind.Runner"
RUN dotnet build "Nethermind.Runner.csproj" -c $BUILD_CONFIGURATION -o /app/build
# This stage is used to publish the service project to be copied to the final stage
FROM build AS publish
ARG BUILD_CONFIGURATION=Release
RUN dotnet publish "Nethermind.Runner.csproj" -c $BUILD_CONFIGURATION -o /app/publish /p:UseAppHost=false
# This stage is used in production or when running from VS in regular mode (Default when not using the Debug configuration)
FROM base AS final
WORKDIR /app
COPY --from=publish /app/publish .
ENTRYPOINT ["dotnet", "nethermind.dll"]
