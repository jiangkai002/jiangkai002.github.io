# 基于 Apache Flink 构建 IoT 数据实时转换管道

> 一个支持 OLAP 批处理和实时推送的双通道数据管道，基于 Apache Flink 1.17 构建，使用 Aviator 表达式引擎实现灵活的数据映射。

---

## 1. 背景与目标

在物联网场景中，设备上报的原始 JSON 数据往往结构复杂、字段命名不一致，且需要同时服务于两类消费场景：

- **OLAP 分析**：需要经过时间窗口聚合、累计转增量等处理，批量写入 ClickHouse/ADB 进行分析查询
- **实时看板**：需要低延迟推送到前端，附带维度信息（项目名称、设备型号等）

本项目实现了一个统一的 Flink 流处理任务，通过**一条公共处理链 + 两条并行输出管道**的架构，同时满足以上两种需求。

---

## 2. 整体架构

```
                          ┌──────────────────────────┐
                          │     Web API (配置中心)      │
                          └─────────┬────────────────┘
                                    │ REST 查询映射配置
  ┌─────────┐              ┌───────▼──────────────────┐
  │  Kafka  │──────────────│  DataWithConfigSource     │
  │ (IoT数据)│  订阅Topic   │  动态管理 Kafka 消费者      │
  └─────────┘              └───────┬──────────────────┘
                                   │ Tuple3<JSON, Mapping, Timestamp>
                          ┌────────▼─────────┐
                          │ 1. Transform      │  JSON 展开 + Aviator 表达式 + 类型转换
                          └────────┬─────────┘
                          ┌────────▼─────────┐
                          │ 2. NullHandle     │  空值填充 (Last/Default)
                          └────────┬─────────┘
                          ┌────────▼─────────┐
                          │ 3. TimeDimMap     │  时间维度展开 (年/月/日/时/分/秒/周)
                          └──┬──────┬───────┘
                             │      │
              ┌──────────────┘      └──────────────┐
              ▼ OLAP 路径                          ▼ 实时路径
  ┌───────────────────────┐            ┌───────────────────────┐
  │ 4. TimeWindow (聚合)   │            │ 4R. Throttle (限流)    │
  │ 5. Increment (增量)    │            │ 5R. DimensionJoin      │◄── MySQL 维度表
  │ 6. BatchSink (批写)    │            │ 6R. RedisSink (推送)   │
  └───────────┬───────────┘            └───────────┬───────────┘
              ▼                                    ▼
  ┌───────────────────┐              ┌───────────────────┐
  │  ADB / ClickHouse  │              │      Redis         │
  │  (历史分析)         │              │  (实时看板 + 推送)  │
  └───────────────────┘              └───────────────────┘
```

核心入口在 `Job.java`，两条管道的启动清晰可见：

```java
// Job.java:63-65 — 两条管道并行运行于同一个 Flink Job
olapPipeline(env);
realTimePipeline(env);
env.execute("TransformAndSink" + flinkId);
```

---

## 3. 公共处理链

无论是 OLAP 还是实时路径，数据都先经过相同的三个算子处理。

### 3.1 TransformFunction — 数据解析与映射

这是整个管道的核心算子，完成 JSON 展开、表达式求值、类型转换三件事。

**嵌套 JSON 展开 (ObjectSpread)：**

IoT 设备上报的 JSON 往往包含嵌套对象和数组。例如一个空调网关同时上报多台内机的数据：

```json
{
  "gatewayId": "GW001",
  "timestamp": 1715875200,
  "indoorUnits": [
    {"unitId": "U1", "temp": 26.5, "mode": "cool"},
    {"unitId": "U2", "temp": 24.0, "mode": "heat"}
  ]
}
```

`ObjectSpread` 通过 `$` 和 `#` 两种特殊标记实现展开和遍历：

```java
// ObjectSpread.java:17-28 — 根据 keyField 决定展开策略
public static List<Map<String, Object>> spreadObject(JSONObject obj, String key, String mappingId) {
    List<Map<String, Object>> res = new ArrayList<>();
    if (key == null || key.equals("")) {
        res.add(getMap(obj, "key", mappingId));
    } else if (!key.contains("$") && !key.contains("#")) {
        res.add(getMap(obj, key, mappingId));
    } else {
        res.addAll(getListMaps(obj, key, mappingId));  // $ 和 # 触发数组/对象展开
    }
    return res;
}
```

- `$` 标记路径：从指定字段取值
- `#` 标记：遍历对象的每个 key 拆成多行
- 组合使用 `indoorUnits.#.unitId` 即可将数组拆成多条记录

**Aviator 表达式引擎：**

字段映射支持表达式计算，而非简单的字段重命名。例如将华氏温度转为摄氏温度：

```
temp * 9 / 5 + 32
```

表达式的编译结果被缓存，避免重复编译：

```java
// TransformFunction.java:167-172 — 表达式编译与缓存
if (!expressionMap.containsKey(expression)) {
    Expression exp = null;
    if (!expression.matches("^[a-zA-Z_$#][0-9a-zA-Z_.$#]*$"))  // 简单字段名不编译
        exp = evaluator.compile(expression, true);
    expressionMap.put(expression, exp);
}
```

这是一个很实用的优化——对于纯字段引用（如 `gatewayId`），直接做 Map 取值，只有真正的表达式才走 Aviator 编译。

### 3.2 NullHandleFunction — 空值填充

IoT 数据经常出现字段缺失。`NullHandleFunction` 提供两种策略：

- **Last 模式**：用上一个值的同名字段填充（通过 Flink ValueState 维护）
- **Default 模式**：按数据类型给默认值（字符串="", 数字=0, 布尔=false, 时间=当前时间）

```java
// NullHandleFunction.java:27-54 — 空值处理逻辑
for (DataMappingItem relation : dataItem.mapping.relationDatails) {
    Object currentValue = dataItem.item.getValue(relation.targetField);
    if (relation.nullMode == NullMode.Last) {
        if (currentValue == null) {
            currentValue = value.get(relation.targetField);  // 取上一次的值
        } else {
            value.replace(relation.targetField, currentValue); // 更新缓存
        }
    }
    if (currentValue == null) switch (relation.dataType) {
        case String:  currentValue = ""; break;
        case Number:  currentValue = 0; break;
        case Boolean: currentValue = false; break;
        case Time:    currentValue = new Date().getTime(); break;
    }
    dataItem.item.setValue(relation.targetField, currentValue);
}
```

### 3.3 TimeDimensionMapFunction — 时间维度展开

将时间戳字段拆成 `_year`, `_month`, `_day`, `_hour`, `_minute`, `_second`, `_week`, `_weekday` 八个维度字段，方便下游直接做 GROUP BY 聚合：

```java
// TimeDimensionMapFunction.java:34-52 — 时间维度展开
int year = calendar.get(Calendar.YEAR);
item.setValue(name + "_year", year);
int month = calendar.get(Calendar.MONTH) + 1;
item.setValue(name + "_month", month);
int day = calendar.get(Calendar.DAY_OF_MONTH);
item.setValue(name + "_day", day);
// ... hour, minute, second, week, weekday
```

---

## 4. OLAP 分析路径

OLAP 路径面向历史数据分析，关键步骤是**时间窗口聚合**和**累计转增量**。

### 4.1 TimeWindowProcessFunction — 时间窗口聚合

同一 key 在时间窗口内的多条数据会被合并，支持 first/last/min/max/avg/count/sum 七种聚合方法。

核心实现在 `DataAccumulator`：

```java
// DataAccumulator.java:64-92 — 数值字段的聚合逻辑
case avg:
    valueResult = (value1 * (this.count - 1) + value2) / this.count;  // 增量计算平均值
    break;
case sum:
    valueResult = value1 + value2;
    break;
```

窗口基于事件时间对齐，并有 30 秒强制关闭兜底，防止上游无数据时窗口永不关闭：

```java
// TimeWindowProcessFunction.java:54-56 — 30秒强制关闭
long forceEndWindowTime = Math.max(windowEnd, timerService.currentProcessingTime()) + 1000L * 30;
timerService.registerProcessingTimeTimer(forceEndWindowTime);
```

### 4.2 IncrementHandleFunction — 累计值转增量

某些 IoT 指标是累计值（如设备运行总时长、总能耗），分析时需要转为周期增量：

```java
// IncrementHandleFunction.java:28-37
double currentFieldValue = ((Number) dataItem.getValue(relation.targetField)).doubleValue();
double incrementValue = currentFieldValue - lastValue.get(relation.targetField);
if (incrementValue < 0) {
    item.item.setValue(relation.targetField, 0);  // 负值归零（可能是设备重置）
} else {
    item.item.setValue(relation.targetField, incrementValue);
    lastValue.put(relation.targetField, currentFieldValue);
}
```

### 4.3 BatchSink — 批量写入

通过 10 秒滚动窗口 + CountAndTimeTrigger（达到 1000 条立即触发），将数据攒批后通过 JDBC batch 写入数据库。

```java
// Job.java:87-90
stream.keyBy(x -> x.item.transformId).window(TumblingProcessingTimeWindows.of(Time.seconds(10)))
    .trigger(new CountAndTimeTrigger(1000L))
    .process(new BatchSinkProcessFunction())
    .addSink(mode.equals("ADB") ? new AdbSinkFunction(...) : new ClickHouseSinkFunction(...));
```

Sink 层做了**无限重试 + 断连重连**保证写入可靠性：

```java
// AdbSinkFunction.java:51-73 — 无限重试直到写入成功
while (true) {
    try (PreparedStatement preparedStatement = connection.prepareStatement(getSql(tableName, fields))) {
        // ... 设置参数并执行 batch
        connection.commit();
        break;  // 成功则跳出循环
    } catch (Exception ex) {
        if (!testConnection(connection)) connect();  // 断连则重连后重试
        else break;  // 非连接错误则放弃
    }
}
```

---

## 5. 实时推送路径

实时路径面向看板展示，关键是**限流削峰**和**维度关联**。

### 5.1 ThrottlingProcessFunction — 限流

同一 key 的数据 500ms 内只放行一条，同时丢弃超过 60 秒的过期数据：

```java
// ThrottlingProcessFunction.java:16-27
if (t.item.timestamp < context.timerService().currentProcessingTime() - 1000 * 60) return; // 丢弃过期数据
if (!pause.value()) {
    collector.collect(t);
    pause.update(true);
    context.timerService().registerProcessingTimeTimer(
        context.timerService().currentProcessingTime() + 500L);  // 500ms 内拦截后续数据
}
```

### 5.2 DimensionsJoinFunction — 维度关联

通过 Flink Connect 算子将维度数据流与主数据流关联。维度数据由 `DimensionsSource` 从 MySQL 每 10 分钟全量拉取一次。

```java
// DimensionsJoinFunction.java:21-36
for (DimensionInfo dimInfo : filteredDimInfos) {
    HashMap<String, HashMap<String, Object>> dimensionData = dimensions.get(dimInfo.type);
    Object rawKey = dataItem.item.getValue(dimInfo.name + "_key");
    String key = (rawKey == null) ? "" : rawKey.toString();
    HashMap<String, Object> data = dimensionData.get(key);
    if (data == null) continue;
    for (String field : data.keySet()) {
        dataItem.item.setValue(dimInfo.name + "." + field, data.get(field));
    }
}
```

### 5.3 RedisSinkFunction — Redis 写入

使用 Jedis Pipeline 批量写入，同时执行 HSET + EXPIRE + PUBLISH 三个操作，实现数据存储和推送：

```java
// RedisSinkFunction.java:81-97 — 单条数据的 Redis 写入
synchronized (this) {
    ensurePipeline();
    currentPipeline.hset(hashKey, key, json);
    currentPipeline.expire(hashKey, 86400);     // 24h TTL
    currentPipeline.publish(channel, json);      // 推送通知订阅者
    pendingCount++;
    if (pendingCount >= FLUSH_BATCH_SIZE) {
        doFlush();
    }
}
```

Pipeline 结合 100ms 定时 flush 机制，兼顾吞吐和延迟。

---

## 6. 动态配置管理

`DataWithConfigSource` 是这个项目最有意思的设计之一。它通过 Web API 动态拉取配置，自动管理 Kafka 消费者的生命周期：

```java
// DataWithConfigSource.java:80-134 — 配置更新主循环
while (isRunning) {
    // 1. 从 Web API 拉取所有映射配置
    ArrayList<DataMapping> mappings = WebApi.getAllMappings(flinkId, flinkSecret, host, isDefault);
    
    // 2. 关闭不再需要的 Kafka 消费者
    for (Object k : consumerMap.keySet().toArray()) {
        if (!newMappings.containsKey(k)) {
            SourceKafkaConsumer old = consumerMap.get(k);
            old.stop();
            consumerMap.remove(k);
        }
    }
    
    // 3. 启动新的 Kafka 消费者
    for (String key : newMappings.keySet()) {
        if (!consumerMap.containsKey(key)) {
            SourceKafkaConsumer consumer = new SourceKafkaConsumer(...);
            executor.submit(consumer);
            consumerMap.put(key, consumer);
        }
    }
    
    // 4. 30 秒后再次检查
    updateConfigWait.wait(1000 * 30);
}
```

这意味着新增一个数据映射不需要重启 Flink 任务——在 Web 后台配置完成后，最多 30 秒就会自动开始消费新的 Kafka Topic。

---

## 7. 容错与监控

**Checkpoint 机制：**

```java
// Job.java:135-158 — Flink 容错配置
env.enableCheckpointing(30000);                                    // 30 秒一次
env.getCheckpointConfig().setCheckpointingMode(CheckpointingMode.EXACTLY_ONCE);
env.setRestartStrategy(RestartStrategies.fixedDelayRestart(10000,
    org.apache.flink.api.common.time.Time.of(1, TimeUnit.MINUTES))); // 失败后重试 10000 次
env.getCheckpointConfig().setExternalizedCheckpointCleanup(
    CheckpointConfig.ExternalizedCheckpointCleanup.RETAIN_ON_CANCELLATION); // 取消时保留
```

**运行监控：**

`LogCollector` 通过 Redis 暴露任务状态和日志，支持外部监控系统查询。每 30 秒上报一次，包括各映射的数据吞吐速度、最新数据时间、错误日志等。

```java
// LogCollector.java:139-157 — 状态上报
public static void uploadStatusToRedis() {
    try (Jedis jedis = jedisPool.getResource()) {
        for (Map.Entry<String, JobStatus> entry : jobStatusMap.entrySet()) {
            JobStatus status = entry.getValue();
            status.speed = (double) (status.count - status.lastCount) 
                / (System.currentTimeMillis() - lastUploadTime) * 1000;  // 条/秒
            jedis.hset("DataPipeline/Status", status.id, JSON.toJSONString(status));
        }
    }
}
```

---

## 8. 总结

这个项目的几个核心设计思路值得回顾：

1. **双通道复用公共逻辑**：Transform → NullHandle → TimeDim 三个算子被 OLAP 和实时管道共享，避免了代码重复
2. **动态配置驱动**：Kafka 消费者的启停完全由 Web API 下发的配置决定，新增接入无需重启
3. **表达式引擎**：Aviator 让字段映射具备了计算能力，而不仅仅是重命名
4. **多级聚合**：通过 DataAccumulator 在时间窗口内做增量聚合，支持 7 种聚合方法
5. **防御性设计**：无限重试写入、断连重连、时间窗口强制关闭、负值归零——这些都是生产环境中踩坑后的修补

| 维度 | OLAP 路径 | 实时路径 |
|------|----------|---------|
| 目标 | ClickHouse / ADB 历史分析 | Redis 实时看板 |
| 写入方式 | JDBC Batch (REPLACE INTO) | Jedis Pipeline (HSET+PUBLISH) |
| 数据处理 | 时间窗聚合 + 累计转增量 | 限流 + 维度关联 |
| 延迟 | 10s 窗口 + 批次 | < 500ms |
| 数据量 | 全量 + 历史回溯 | 只看最新 |

完整的逻辑图可用 draw.io 打开项目根目录的 `project-logic-diagram.drawio` 查看。
