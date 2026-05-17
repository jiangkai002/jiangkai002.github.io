# 从零搭建企业级数据管道平台：IBuildingCloud DataPipeline 架构剖析

> 本文深入剖析一套基于 .NET 6 + Vue 2 的企业级数据管道与 OLAP 分析平台，涵盖数据接入、实时处理、多维聚合查询、WebSocket 推送等核心技术链路。

---

## 一、项目概览

IBuildingCloud DataPipeline 是一个面向智慧建筑场景的大数据管道平台，核心解决三大问题：

1. **多源异构数据接入** — MySQL、SQL Server、Kafka、MQTT、REST API 等数据源统一管理
2. **数据建模与 OLAP 多维分析** — 维度建模、聚合查询、上卷下钻
3. **实时数据推送** — 基于 Redis Pub/Sub + SignalR 的低延迟数据推送

技术栈方面，后端使用 ASP.NET Core 6.0，前端使用 Vue 2 + TypeScript + Vuetify，存储层覆盖 MongoDB（元数据）、MySQL（关系数据）、Redis（实时缓存）、AnalyticDB / ClickHouse（OLAP引擎）。

整体逻辑架构如下（对应 `project_logic_diagram.drawio`，可直接用 draw.io 打开）：

```
┌──────────────────────────────────────────────────────────────┐
│                    前端 (Vue 2 + TS)                          │
│  ┌──────────┐  ┌──────────────────┐  ┌──────────────┐       │
│  │ 前台看板  │  │ 设置(数据接入/建模) │  │ 后台(外部嵌入) │       │
│  └──────────┘  └──────────────────┘  └──────────────┘       │
├──────────────────────────────────────────────────────────────┤
│                HTTP REST / WebSocket (SignalR)                │
├──────────────────────────────────────────────────────────────┤
│                 后端 (ASP.NET Core 6.0)                        │
│  ┌──────────┐  ┌──────────────┐  ┌────────────────────┐     │
│  │Controller│→│   Service     │→│  IQueryExecutor     │     │
│  │  28个    │  │  业务逻辑层    │  │  ADB / ClickHouse  │     │
│  └──────────┘  └──────────────┘  └────────────────────┘     │
│                                           │                   │
│  ┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐ ┌──┴──┐               │
│  │MongoDB│ │MySQL │ │Redis │ │Kafka │ │Flink│               │
│  │(元数据)│ │(关系)│ │(缓存)│ │(消息)│ │(计算)│               │
│  └──────┘ └──────┘ └──────┘ └──────┘ └─────┘               │
└──────────────────────────────────────────────────────────────┘
```

---

## 二、启动配置：双引擎灵活的存储切换

项目启动时支持通过 `MODE` 环境变量切换 OLAP 引擎，这是整个系统的核心设计决策之一。相关代码在 `Startup.cs`:

```csharp
// Startup.cs:45-65
public override void ConfigureServices(IServiceCollection services)
{
    base.ConfigureServices(services);
    var model = Configuration.GetValue<string>("MODE");
    if (model == "ADB")
    {
        services.AddTransient<ISqlExecutor, SqlExecutor>();
        services.AddTransient<IQueryExecutor, AdbQueryExecutor>();
        services.AddTransient<ISchemaManager, AdbSchemaManager>();
        services.AddTransient<IAggregateFunctions, AdbFunctions>();
        services.AddTransient<ITableDataRepository, AdbTableDataRepository>();
    }
    else if (model == "CH")
    {
        services.AddTransient<ISqlExecutor, SqlExecutor>();
        services.AddTransient<IQueryExecutor, ClickHouseQueryExecutor>();
        services.AddTransient<ISchemaManager, ClickHouseSchemaManager>();
        services.AddTransient<IAggregateFunctions, ClickHouseFunctions>();
        services.AddTransient<ITableDataRepository, ClickHouseTableDataRepository>();
    }
    // ...
}
```

这种设计使得上层业务代码完全依赖 `IQueryExecutor`、`ISchemaManager`、`IAggregateFunctions` 三个接口，切换存储引擎只需改一个配置项，满足不同客户的部署需求。

同时注入的核心中间件包括 Redis（StackExchange.Redis）、SignalR、以及基于 NSwag 生成的 Auth / MessageCenter 客户端：

```csharp
// Startup.cs:73-84
var httpClient = new HttpClient();
httpClient.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer",
    TokenUtil.MakeRootToken(Configuration.GetValue<String>("SECRET"), TimeSpan.FromDays(3650)));

services.AddSingleton(new MessageCenterClient(Configuration.GetValue<string>("MESSAGECENTER_URL"), httpClient));
services.AddSingleton(new AuthClient(Configuration.GetValue<string>("AUTH_URL"), httpClient));

services.AddSingleton(redisDb.GetDatabase());
services.AddSingleton(redisDb.GetSubscriber());
services.AddSignalR(x => x.EnableDetailedErrors = true);
```

---

## 三、核心抽象：IQueryExecutor 接口设计

整个 OLAP 查询能力的抽象层是 `IQueryExecutor`，定义了聚合、维成员、事实明细、最新值等查询契约：

```csharp
// Interfaces/IQueryExecutor.cs
public interface IQueryExecutor
{
    Task<AggregateResult> Aggregate(DataCube cube,
        List<Cut> cuts, List<DrillDown> drillDowns,
        Paging paging, List<string> aggregates, List<Order> orders);

    Task<List<Dictionary<string, object>>> Fact(DataCube cube,
        List<Cut> cuts, Paging paging,
        List<Order> order, List<string> fields);

    Task<int> AggregateCount(DataCube cube,
        List<Cut> cuts, List<DrillDown> drillDowns);

    Task<MemberResult> Member(DataCube cube,
        List<Cut> cuts, DrillDown drillDown,
        Paging paging, List<Order> order);

    Task<List<Dictionary<string, object>>> Latest(DataCube cube,
        List<Cut> cuts, List<DrillDown> drillDowns,
        Paging paging, List<Order> order, List<string> fields);
}
```

`SqlQueryExecutor` 是 ADB 和 ClickHouse 的公共基类，包含 SQL 拼接的核心逻辑：

```csharp
// Models/Storage/SqlQueryExecutor.cs:30-59
public async Task<AggregateResult> Aggregate(DataCube cube,
    List<Cut> cuts, List<DrillDown> drillDowns,
    Paging paging, List<string> aggregates, List<Order> orders)
{
    var param = new SqlParams("p", 1);

    var cols = GetAggregateFields(cube, aggregates, drillDowns);
    var joinStr = GetJoin(cube);
    var whereStr = GetWhere(cube, cuts, param);
    var groupStr = GetGroupBy(cube, drillDowns);
    var orderStr = GetOrder(cube, orders);
    var pagingStr = GetPaging(paging, param);

    var sql = @$"SELECT {string.Join(", ", cols.Select(c => $"{c.Name}"))}
                  FROM {joinStr}";
    if (whereStr != null) sql += " " + whereStr;
    if (groupStr != null) sql += " " + groupStr;
    if (orderStr != null) sql += " " + orderStr;
    if (pagingStr != null) sql += " " + pagingStr;

    var result = await exe.ExecuteQuery(sql, param);
    return new AggregateResult()
    {
        Aggregates = aggregates,
        Cell = cuts,
        Cells = BuildResult(cube, cols, result),
    };
}
```

**关键点**：SQL 的参数化查询使用了自定义 `SqlParams` 而非字符串拼接，有效防止 SQL 注入。ADB 和 ClickHouse 的子类只需要 override `GetJoin`、`GetWhere` 等 SQL 方言差异部分，核心查询逻辑完全复用。

---

## 四、OLAP 查询链路：从 API 到 SQL

以一次聚合查询为例，完整链路如下：

### 4.1 Controller — 参数解析与权限校验

```csharp
// Controllers/OlapController.cs:29-41
[Route("/api/datapipeline/projects/{projectId}/cube/{id}/aggregate")]
[HttpGet]
[ResponseCache(Duration = 60)]
public async Task<AggregateResult> Aggregate(int projectId, string id,
    string cut, string drilldown, string aggregates,
    int page, int pagesize, string order)
{
    var token = this.GetToken();
    var cuts = ParseCut(cut);
    var drillDowns = ParseDrillDown(drilldown);
    var aggrs = ParseString(aggregates, ',');
    var orderBy = ParseOrder(order);
    return await service.GetAggregates(
        projectId, id, cuts, drillDowns, aggrs,
        page, pagesize, orderBy, token);
}
```

### 4.2 Service — 模型加载与权限验证

```csharp
// Services/OlapService.cs:27-33
public async Task<AggregateResult> GetAggregates(int projectId,
    string cubeNameOrId, List<Cut> cuts, List<DrillDown> drillDowns,
    List<string> aggrs, int page, int pagesize,
    List<Order> order, AuthToken token)
{
    var cube = await cubeService.GetOne<int>(
        x => x.Name == cubeNameOrId || x.Id == cubeNameOrId, projectId);
    cube.Authorities.Validate(token, HttpMethod.Get);
    var paging = new Paging() { Page = page, PageSize = pagesize };
    return await exe.Aggregate(cube, cuts, drillDowns, paging, aggrs, order);
}
```

整个查询链路：**前端 Vue → HTTP API → OlapController(参数解析) → OlapService(权限+编排) → IQueryExecutor(SQL生成) → ADB/ClickHouse**。

---

## 五、实时数据推送：SignalR + Redis Pub/Sub

实时数据是数据管道平台的刚需。该项目的实时推送架构非常精巧：

```
Kafka → Flink Job(清洗) → Redis Hash(写入) → Redis Pub/Sub → SignalR Hub → 前端 WebSocket
```

### 5.1 订阅管理 — 三层字典

`RealTimeWebSocketHub` 是核心，使用三层静态字典管理订阅关系：

```csharp
// Services/RealTimeWebSocketHub.cs:32-40
// 三层的key分别为 redis中的topic, connection的Id, 订阅的Id
// 之所以每次订阅都有一个Id是为了允许前端的不同组件各自订阅相同的内容
// 当一个connection里的所有订阅都取消了则删除该connection和topic的关系，
// 如果一个topic下没有connection则不订阅该topic
private static Dictionary<string, Dictionary<string, HashSet<string>>> topics
    = new Dictionary<string, Dictionary<string, HashSet<string>>>();

// 客户端的订阅列表
private static Dictionary<string, (string topic, string connId)> clientSubs
    = new Dictionary<string, (string, string)>();
```

订阅与取消逻辑：

```csharp
// Services/RealTimeWebSocketHub.cs:51-75
public async Task<string> Subscribe(int projectId, string nameOrId, string key)
{
    var id = await GetId(nameOrId, projectId);
    var topic = $"{topicPrefix}-{id}-{projectId}-{key}";
    var guid = Guid.NewGuid().ToString();
    await Groups.AddToGroupAsync(Context.ConnectionId, topic);

    if (!topics.ContainsKey(topic))
    {
        topics.Add(topic, new Dictionary<string, HashSet<string>>());
        await subscriber.SubscribeAsync(topic, (c, v) =>
        {
            var match = regex.Match(c);
            if (!match.Success) return;
            hubCtx.Clients.Group(topic).SendAsync(
                "data", match.Groups[1].Value, v.ToString());
        });
    }

    if (!topics[topic].ContainsKey(Context.ConnectionId))
        topics[topic].Add(Context.ConnectionId, new HashSet<string>());
    topics[topic][Context.ConnectionId].Add(guid);
    clientSubs.Add(guid, (topic, Context.ConnectionId));
    return guid;
}
```

**设计要点**：
- 每个订阅分配唯一 GUID，允许同一连接的多个组件独立订阅和取消
- Redis Pub/Sub 的回调中使用 `IHubContext` 而非 `Clients`，避免 Hub 实例生命周期问题
- 连接断开时自动清理所有订阅（`OnDisconnectedAsync`）
- topic 无订阅者时自动 unsubscribe Redis channel，节省资源

### 5.2 REST 降级 — RealTimeService

除了 WebSocket 推送外，也提供了 REST API 的降级方案：

```csharp
// Services/RealTimeService.cs:33-41
public async Task<string> GetMultipleData(string nameOrId, int projectId,
    IEnumerable<string> keys, AuthToken token)
{
    var id = await GetId(nameOrId, projectId, token);
    var tasks = keys.Select(key => $"RT-{id}-{projectId}-{key}")
        .Select(x => cache.HashGetAsync(id, x)).ToArray();
    var results = tasks.Select(x =>
        x.Result.IsNullOrEmpty ? "" : Encoding.UTF8.GetString(x.Result)).ToArray();
    return $"[{string.Join(",", results.Where(x => !string.IsNullOrEmpty(x)))}]";
}
```

直接从 Redis Hash 中批量读取，响应格式为 JSON 数组，前端轮询取数。

---

## 六、数据建模：DataCube 的创建与物理表联动

创建 DataCube 不仅写入 MongoDB 元数据，还会自动在 OLAP 引擎中创建物理表：

```csharp
// Services/DataCubeService.cs:35-53
public override async Task<string> Add(DataCube item, int projectId)
{
    item.Id = ObjectId.GenerateNewId().ToString();
    item.ProjectId = projectId;
    item.Version = 1;
    var old = await repo.GetOne(x => x.Name == item.Name, projectId: projectId);
    if (old != null) throw new Exception("已存在同名称的数据集");
    try
    {
        await schema.CreateFact(item);  // 在 ADB/CH 中建表
    }
    catch (Exception ex)
    {
        throw new Exception("为数据集建表失败，原因：" + ex.Message);
    }
    await repo.Add(item, projectId: projectId);
    return item.Id;
}
```

`ISchemaManager.CreateFact()` 会根据 DataCube 的维度、度量、详情字段定义，自动生成对应数据库表的 DDL 并执行。

---

## 七、数据映射：从数据源到 OLAP 模型的桥接

`DataMapping` 是连接数据源和 DataCube 的关键模型：

```csharp
// Models/Mapping/DataMapping.cs
public class DataMapping : IMongoDbEntity
{
    public string SourceId { get; set; }        // 数据源ID
    public string TargetId { get; set; }        // 目标Cube ID
    public string KeyField { get; set; }        // 主键字段
    public string TimeField { get; set; }       // 时间字段
    public string Type { get; set; }            // 映射处理Jar类型
    public List<DataMappingItemInfo> Relations { get; set; }  // 字段映射关系
    public Dictionary<string, string> Settings { get; set; }  // 额外配置
    public int? MaxInterval { get; set; }       // 超时告警阈值
}
```

`SetupCube()` 方法将 Cube 的度量聚合方法（sum/count/avg/max/min/last）和字段类型自动填充到映射关系中，实现字段级别的语义对齐。

---

## 八、前端路由设计：多层级模块化

前端 Vue Router 按"项目 → 前台 / 设置 / 后台"三层组织：

```typescript
// router/index.ts
export default new Router({
  mode: "history",
  base: process.env.BASE_URL,
  routes: [{
    path: "/projects/:projectId",
    component: Project,
    children: [
      { path: "", component: Navigation, children: fontstageRoutes },
      { path: "settings", component: Settings, children: settingsRoutes },
      { path: "backstage", component: BackStage, children: backstageRoutes },
    ],
  }],
});
```

设置页面的子路由涵盖完整的数据管理流程：

```typescript
// router/settings.ts
export const settingsRoutes: RouteConfig[] = [
  {
    path: "datainput",     // 数据接入
    component: () => import("../views/DataInput.vue"),
    children: [
      { path: "datasource/new",    component: () => import("...DataSourceEditor.vue") },
      { path: "datamapping/new",   component: () => import("...DataMappingEditor.vue") },
      { path: "log/:dbId",         component: () => import("...LogViewer.vue") },
    ],
  },
  {
    path: "datamodeling",   // 数据建模
    component: () => import("../views/DataModeling.vue"),
    children: [
      { path: "datacube/new",      component: () => import("...DataCubeEditor.vue") },
      { path: "dimension/new",     component: () => import("...DimensionEditor.vue") },
    ],
  },
  { path: "flinks", component: () => import("../views/FlinkManage.vue") },
];
```

全部路由组件使用动态 `import()` 实现按需加载，减少首屏包体积。

---

## 九、安全与认证体系

系统采用多层认证机制：

| 机制 | 说明 |
|------|------|
| **Bearer Token** | 标准 JWT，由外部 Auth 服务签发，`ValidateToken()` 校验项目权限和角色 |
| **Flink Secret** | 自定义中间件，Flink 集群通过 `flinkId + flinkSecret` 签名认证 |
| **Root Token** | 超级管理员，3650天有效期，可操作公共项目(projectId=1) |
| **API 授权** | `[Authorize]` + `Authority.大数据平台管理员` / `Authority.管理数据接入` / `Authority.管理数据模型` 等角色控制 |

```csharp
// Startup.cs — Flink 认证中间件
if (flinkId != null && flinkSecret != null &&
    FlinkSecretUtils.MakeFlinkSecret(flinkId, Configuration.GetValue<string>("SECRET")) == flinkSecret)
    ctx.Request.Headers.Add("Authorization", "Bearer " +
        TokenUtil.MakeRootToken(Configuration.GetValue<string>("SECRET"), TimeSpan.FromDays(1)));
```

---

## 十、总结

这套数据管道平台的架构亮点：

1. **存储引擎抽象** — `IQueryExecutor` 接口屏蔽 ADB/ClickHouse 差异，配置级切换
2. **实时推送架构** — Redis Pub/Sub + SignalR + 三层订阅字典，连接断开自动清理
3. **元数据驱动** — MongoDB 存储 DataCube/Dimension/DataMapping 模型定义，ADB/CH 自动建表
4. **前后端分离** — ASP.NET Core REST API + Vue SPA + WebSocket，按需加载路由
5. **企业级安全** — Bearer Token + Flink Secret + 角色权限三级认证

完整的架构图文件见 `project_logic_diagram.drawio`，可用 [draw.io](https://app.diagrams.net) 打开编辑。

---

*项目仓库: ibuildingcloud.datapipeline · 技术栈: .NET 6 / Vue 2 / TypeScript / MongoDB / Redis / Kafka / Flink / ADB / ClickHouse*
