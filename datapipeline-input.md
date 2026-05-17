# .NET 6 多源异构数据采集管道：从 MQTT、REST API、Kafka 到关系型数据库的一站式接入方案

> 本文介绍一套基于 .NET 6 Worker Service 构建的多源数据采集服务，它支持 6 类异构数据源，通过统一的 Kafka 管道输出，配合 Redis 实现状态监控与断点续传，并天然支持水平扩展。

---

## 1. 背景与定位

在企业数据中台建设中，面临的首要问题是：**业务数据散落在各式各样的系统中**——物联网设备通过 MQTT 上报遥测数据、第三方系统暴露 REST API、内部微服务之间通过 Kafka 传递事件、核心业务数据沉淀在 MySQL / SQL Server 中。如果为每一种数据源单独开发一套接入程序，维护成本会线性增长。

这个项目（IBuildingCloud.DataPipeline.Input）解决的就是这个问题：**用一套可配置、可扩展的采集框架，把异构数据源统一接入到 Kafka 管道中，供下游流计算、数据仓库等消费。**

技术栈：**.NET 6 Worker Service + Confluent.Kafka + StackExchange.Redis + MQTTnet**

---

## 2. 整体架构

架构分为三层：**控制面**、**采集层**、**输出层**。

```
┌──────────────────────────────────────────────────────┐
│            DataPipeline Platform API                 │
│          (配置中心：DataSource CRUD)                   │
└──────────────────────┬───────────────────────────────┘
                       │ GetSourcesAsync() 每30秒拉取
                       ▼
┌──────────────────────────────────────────────────────┐
│              DemonWorker (调度器)                      │
│   对比配置版本 → 启停 Worker → 上报状态到 Redis         │
└───┬──────┬──────┬──────┬──────┬──────┬───────────────┘
    │      │      │      │      │      │
    ▼      ▼      ▼      ▼      ▼      ▼
┌──────┬──────┬──────┬──────┬──────┬──────┐
│ MQTT │WebAPI│PrivAPI│Kafka │MySQL │ SQL  │
│Worker│Worker│Worker │Worker│Worker│Server│  ← 6种采集器
└──┬───┴──┬───┴───┬───┴──┬───┴──┬───┴──┬───┘
   │      │       │      │      │      │
   └──────┴───────┴──────┴──────┴──────┘
                    │ Output() 统一出口
                    ▼
┌──────────────────────────────────────────────────────┐
│         Kafka Topics: source-{SourceId}              │
│              (下游流计算消费)                          │
└──────────────────────────────────────────────────────┘
                    │
                    ▼
┌──────────────────────────────────────────────────────┐
│   Redis: Status / LatestData / Logs / lastId 断点    │
└──────────────────────────────────────────────────────┘
```

---

## 3. 核心设计详解

### 3.1 插件化 Worker 工厂

6 种数据源对应 6 个 Worker 类，全部继承自抽象基类 `SourceWorker`。工厂方法通过类型字符串动态选择：

```csharp
// SourceWorker.cs:17-29
public static SourceWorker? Make(DataSource source, IServiceProvider services)
{
    SourceWorker? worker = source.Type switch
    {
        "mqtt-source"       => services.GetService<MqttSourceWorker>(),
        "mysql-source"      => services.GetService<MySqlSourceWorker>(),
        "sqlserver-source"  => services.GetService<SqlServerSourceWorker>(),
        "restapi-source"    => services.GetService<WebApiSourceWorker>(),
        "privateapi-source" => services.GetService<PrivateWebApiSourceWorker>(),
        "kafka-source"      => services.GetService<KafkaSourceWorker>(),
        "excel-source"      => services.GetService<KafkaSourceWorker>(),  // 复用
        "postapi-source"    => services.GetService<KafkaSourceWorker>(),  // 复用
        _ => null
    };
    if (worker != null) worker!._source = source;
    return worker;
}
```

这里值得注意的细节：
- Worker 注册为 **Transient**，每次创建新实例，保证每个数据源拥有独立的 Kafka Producer、HTTP Client、MQTT Client 和计数器。
- `excel-source` 和 `postapi-source` 复用 `KafkaSourceWorker`，说明它们本质上都是 Kafka 消费场景的不同入口。
- `null` 返回被调度器忽略，不会阻塞其他正常 Worker。

DI 注册在 `Program.cs` 中简洁直观：

```csharp
// Program.cs:20-26
services.AddTransient<MqttSourceWorker>();
services.AddTransient<PrivateWebApiSourceWorker>();
services.AddTransient<WebApiSourceWorker>();
services.AddTransient<MySqlSourceWorker>();
services.AddTransient<SqlServerSourceWorker>();
services.AddTransient<KafkaSourceWorker>();
services.AddSingleton(new DataSourceController(baseUrl, httpClient));
services.AddHostedService<DemonWorker>();
services.AddSingleton<IDatabaseAsync>(redisDb.GetDatabase());
```

> **设计启发**：如果未来需要接入 MongoDB、PostgreSQL 或 gRPC 数据源，只需新增一个 Worker 子类 + 在 switch 中加一个 case + 一行 `AddTransient` 注册，框架无需任何改动。这就是面向抽象编程的核心价值。

---

### 3.2 调度器：DemonWorker 的版本感知机制

`DemonWorker` 是整个系统的心脏，每 30 秒执行一个循环：

```csharp
// DemonWorker.cs:39-86
protected override async Task ExecuteAsync(CancellationToken stoppingToken)
{
    while (!stoppingToken.IsCancellationRequested)
    {
        // 1. 从平台 API 拉取分配给当前节点的 DataSource 列表
        dataSources = await dataSourceController.GetSourcesAsync(...);

        // 2. 移除已经不需要的或版本已更新的 Worker
        foreach (var worker in workers)
        {
            if (dataSources.Any(x => worker.Key == (x.Id, x.Version))) continue;
            await worker.Value!.StopAsync(new CancellationTokenSource(5000).Token);
            workers.Remove(worker.Key);
        }

        // 3. 启动新增的 Worker
        foreach (var dataSource in dataSources)
        {
            if (workers.ContainsKey((dataSource.Id, dataSource.Version))) continue;
            var worker = SourceWorker.Make(dataSource, _services);
            if (worker == null) continue;
            workers.Add((dataSource.Id, dataSource.Version), worker);
            await worker.StartAsync(new CancellationToken());
        }

        // 4. 上报状态到 Redis
        await ReportStatus();
        await ReportLatestData();
        await ReportLogs();

        await Task.Delay(30000, stoppingToken);
    }
}
```

**核心精妙之处在于 key 的设计**：`Dictionary<(string id, int version), SourceWorker?>`。

不是简单地用 `id` 做 key，而是用 `(id, version)` 的组合。这意味着：
- 同一个数据源的配置修改后，version 改变，旧的 Worker 会被自动停止，新的 Worker 以新配置启动。**实现了零停机的热更新配置。**
- Worker 不存在则创建，版本不匹配则替换，版本匹配则保留——这是一个典型的 **Reconciliation Loop**（调和循环），和 Kubernetes Controller 的设计思路一致。

---

### 3.3 统一输出管道

所有 Worker 采集到的数据通过基类的 `Output()` 方法统一输出：

```csharp
// SourceWorker.cs:99-130
protected async Task Output(JsonElement payload)
{
    if (_source == null) throw new Exception("请先使用SetupSource函数初始化");
    var json = JsonSerializer.Serialize(new
    {
        sourceId = _source.Id,
        timestamp = DateTimeOffset.Now.ToUnixTimeMilliseconds(),
        value = payload
    });
    this.latestData = json;
    this.Count++;
    this.LastDataTime = DateTime.Now;
    this.HasNewData = true;

    var message = new Message<string?, string> { Key = null, Value = json };
    var result = await kafkaProducer.ProduceAsync($"source-{Source!.Id}", message);

    if (Source!.Settings.ContainsKey("dataRetentionTime"))
    {
        // 动态设置 Kafka Topic 数据保留时间
        if (double.TryParse(Source.Settings["dataRetentionTime"], out var retentionTime))
        {
            if (Math.Abs(retentionTime - DataRetentionTime) > 0.1)
                await SetTopicExpireTime($"source-{Source!.Id}", DataRetentionTime);
        }
    }

    this.Offset = result.Offset.Value;
}
```

几个关键设计：
- **数据信封**：每条数据包裹 `{ sourceId, timestamp, value }`，下游消费者无需额外上下文就能知道数据来源和时间。
- **Kafka Topic 隔离**：每个数据源对应独立的 `source-{SourceId}` topic，避免不同数据源之间的消费干扰。
- **动态保留时间**：支持通过 DataSource 配置项 `dataRetentionTime` 动态调整 Topic 的数据过期时间——某些数据源可能只需要保留 1 天，有些需要 30 天。
- **计数器**：`Count`、`Offset`、`LastDataTime` 在每个 Output 调用时更新，为调度器的速度计算提供数据基础。

---

### 3.4 增量采集与 Redis 断点续传

对于数据库和分页 API 场景，全量拉取是不可接受的。SQL 和 PrivateWebApi Worker 都实现了基于 Redis 的断点续传。

**SqlSourceWorkerBase 的增量查询逻辑**：

```csharp
// SqlSourceWorkerBase.cs:37-117
protected override async Task ExecuteAsync(CancellationToken stoppingToken)
{
    var redisKey = $"DataPipeline/MySqlSource/{Source!.Id}-{Source!.Version}-LastId";
    connection = CreateConnection();

    // 从 Redis 恢复上次读取的 lastId
    if (UseLastId)
    {
        var redisValue = await redis.StringGetAsync(redisKey);
        if (redisValue.HasValue)
            lastId = int.Parse(redisValue!);
    }

    while (!stoppingToken.IsCancellationRequested)
    {
        var sql = GetSql(lastId);
        // SELECT * FROM table WHERE id > {lastId} LIMIT 1000
        await using var reader = await command.ExecuteReaderAsync(stoppingToken);
        while (await reader.ReadAsync(stoppingToken))
        {
            var id = Convert.ToInt32(reader["id"]);
            if (id > lastId)
            {
                lastId = id;
                hasNewData = true;    // 标记有新数据，跳过等待
            }
            await Output(JsonSerializer.SerializeToElement(json));
        }

        // 有剩余数据 → 立即继续查；无新数据 → 等待 interval 后再查
        if (UseLastId && hasNewData)
            Log("还有剩余数据，立刻开始下一次查询");
        else
            await Task.Delay(TimeSpan.FromMilliseconds(interval), stoppingToken);

        // 持久化断点
        if (UseLastId)
            await redis.StringSetAsync(redisKey, lastId);
    }
}
```

**PrivateWebApiSourceWorker 的分页增量读取**：

```csharp
// PrivateWebApiSourceWorker.cs:112-161
private async Task<bool> QueryPaged()
{
    var pageSize = 100;
    var url = this.url + $"pageNum={pageNum}&pageSize={pageSize}&order=id";

    // ... 请求 API，解析 JSON 数组
    foreach (var element in jsonDocument.RootElement.EnumerateArray())
    {
        var id = idElement.GetInt32();
        if (id <= lastId) continue;   // 跳过已处理的
        lastId = id;
        await Output(element);
    }

    // 判断是否还有下一页
    if (pageLength >= pageSize)
    {
        pageNum++;
        return true;    // 继续翻页
    }
    return false;       // 已读完
}
```

**自适应轮询策略**：当一轮查询发现了新数据（`hasNewData = true`），说明数据源仍有积压，立即发起下一轮查询，不做等待。直到本轮没有新数据时，才等待配置的 `interval`。这保证了高峰期低延迟、低谷期节省资源。

Redis Key 的设计也值得关注：
```
DataPipeline/MySqlSource/{SourceId}-{Version}-LastId
DataPipeline/PrivateWebApi/{SourceId}-{Version}-LastId
```

Key 中包含 `Version`，当数据源配置升级后，断点自动失效，从零开始重新拉取。避免因字段变更导致 id 不兼容。

---

### 3.5 Token 管理与自动刷新

`WebApiSourceWorker` 实现了一套完整的 Token 管理机制：

```csharp
// WebApiSourceWorker.cs:118-226
public async Task<string?> FetchTokenAsync()
{
    if (string.IsNullOrEmpty(tokenUrl)) return null;

    // 命中缓存直接返回
    if (!string.IsNullOrEmpty(cachedToken)) return cachedToken;

    // 双重检查锁定（DCL）
    lock (tokenLock)
    {
        if (!string.IsNullOrEmpty(cachedToken)) return cachedToken;
    }

    // 支持 GET / POST 两种 Token 获取方式
    if (tokenMethod?.ToUpper() == "POST")
    {
        var content = new StringContent(tokenBody, Encoding.UTF8, "application/json");
        response = await client.PostAsync(tokenUrl, content);
    }
    else
        response = await client.GetAsync(tokenUrl);

    // 通过 JSONPath 提取 token
    var json = JObject.Parse(responseContent);
    var token = json.SelectToken(tokenRoute)?.ToString();

    lock (tokenLock) { cachedToken = token; }
    return token;
}

// Token 失效时自动作废缓存
private void InvalidateToken()
{
    lock (tokenLock) { cachedToken = null; }
}
```

Token 管理链路：
1. 请求 API → 返回 401/403 → 调用 `InvalidateToken()` 清空缓存
2. 下次循环 → `cachedToken` 为空 → 重新调用 `FetchTokenAsync()` 获取新 Token
3. `PrivateWebApiSourceWorker` 更进一步：缓存 IBC Token 并设置 5 分钟过期时间，过期自动刷新

---

### 3.6 水平扩展：FlinkId 分片

系统支持多实例部署，每个实例通过环境变量 `FLINK_ID` 标识自己：

```csharp
// DemonWorker.cs:47-49
dataSources = await dataSourceController.GetSourcesAsync(0, null, null,
    $"({(isDefault ? "FlinkId == null || " : "")}FlinkId ==\"{flinkId}\")",
    null, stoppingToken);
```

- 设置了 `FLINK_ID=node-1` 的实例只拉取 `FlinkId == "node-1"` 的 DataSource
- 设置了 `IS_DEFAULT=true` 的实例还会拉取未分配（`FlinkId == null`）的 DataSource
- 通过在平台 API 上为不同 DataSource 分配不同的 FlinkId，可以按数据源粒度做负载均衡

这种设计比无状态随机分配更可控——运维人员可以手动将某些高负载数据源指定到特定节点。

---

## 4. 单数据源完整采集流程（以 MySQL 为例）

一个 MySQL 数据源从配置到输出的完整链路：

```
  Platform API                    DemonWorker                   MySqlSourceWorker              Kafka / Redis
  ────────────                    ───────────                   ────────────────               ─────────────
                                                               ┌──────────────────┐
  ① 配置 DataSource:              ② 30s 循环拉取配置:            │ SetupSource()    │
    Type = "mysql-source"           dataSources =              │ 读取连接字符串     │
    Settings:                       api.GetSourcesAsync()      │ 读取 SQL 模板     │
      connectionString=...                                      │ interval=5000ms   │
      sql=SELECT * FROM T                                      └────────┬─────────┘
      interval=5000                                                        │
                                    ③ 发现新版本:                           │
                                      Make(dataSource) ──────────────────► ④ 从 Redis 读取 lastId
                                      启动 Worker                                    │
                                                                                   │
                                                                          ⑤ 循环查询:
                                                                           SELECT * FROM T
                                                                           WHERE id > {lastId}
                                                                           LIMIT 1000
                                                                                   │
                                                                          ⑥ 逐行 Output():
                                                                            {sourceId, timestamp,
                                                                             value: {id, name, ...}}
                                                                                   │
                                ⑦ ReportStatus():                        ────┴──→ Kafka topic:
                                  Count, Speed, Offset                          source-{SourceId}
                                  ↓
                                ⑧ Redis HASH:
                                  DataPipeline/Status
                                  DataPipeline/LatestData                    ⑨ StringSetAsync():
                                  DataPipeline/Logs                            Redis 保存 lastId
```

---

## 5. 部署架构

项目使用多阶段 Docker 构建：

```dockerfile
# Dockerfile
FROM mcr.microsoft.com/dotnet/aspnet:6.0 AS base
WORKDIR /app

FROM mcr.microsoft.com/dotnet/sdk:6.0 AS build
COPY ["IBuildingCloud.DataPipeline.Input.csproj", "."]
RUN dotnet restore
COPY . .
RUN dotnet build -c Release -o /app/build

FROM build AS publish
RUN dotnet publish -c Release -o /app/publish

FROM base AS final
COPY --from=publish /app/publish .
ENTRYPOINT ["dotnet", "IBuildingCloud.DataPipeline.Input.dll"]
```

运行时通过环境变量注入配置：

| 环境变量 | 用途 |
|---------|------|
| `FLINK_ID` | 节点标识，用于 DataSource 分片分配 |
| `FLINK_SECRET` | 平台 API 认证密钥 |
| `IS_DEFAULT` | 是否接收未分配的 DataSource |
| `DATAPIPELINE_URL` | 上游平台 API 地址 |
| `KAFKA` | 输出 Kafka 集群地址 |
| `PUBLIC_KAFKA` | 外部 Kafka 源默认地址 |
| `REDIS` / `REDIS_PASSWORD` / `REDIS_DB` | Redis 连接信息 |

---

## 6. 总结

这个项目用大约 **700 行核心代码** 实现了对 6 种异构数据源的统一接入，背后有几个值得复用的设计模式：

| 设计模式 | 应用 |
|---------|------|
| **工厂方法** | `SourceWorker.Make()` 根据类型字符串创建对应 Worker |
| **模板方法** | `SourceWorker` 定义 `Output()` + `Log()` 等公用逻辑，子类只需实现 `ExecuteAsync()` 和 `SetupSource()` |
| **调和循环** | `DemonWorker` 每 30s 对比期望状态与实际状态，驱动系统向期望状态靠拢 |
| **双重检查锁定** | `WebApiSourceWorker` 的 Token 缓存，避免并发时重复请求 |
| **断点续传** | SQL / PrivateWebApi Worker 通过 Redis 持久化 `lastId`，支持重启后从断点恢复 |

对于需要构建多源数据接入平台的团队，这套架构提供了一个轻量但完整的参考实现——不需要引入重量级 ETL 工具，用 .NET Worker Service 就能搭建一个可靠的数据采集层。
