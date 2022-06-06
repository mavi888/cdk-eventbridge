import { Stack, StackProps, Aws, CfnOutput, SecretValue, Duration } from 'aws-cdk-lib';
import { Construct } from 'constructs';

import { EventBus, Rule, Connection, Authorization, ApiDestination, HttpMethod, RuleTargetInput} from 'aws-cdk-lib/aws-events';
import { Table, AttributeType } from 'aws-cdk-lib/aws-dynamodb';
import { Function, Runtime, Code, LayerVersion } from 'aws-cdk-lib/aws-lambda';
import { PolicyStatement, Effect} from 'aws-cdk-lib/aws-iam'
import {RestApi, LambdaIntegration} from "aws-cdk-lib/aws-apigateway";
import {CfnPlaceIndex, CfnRouteCalculator} from "aws-cdk-lib/aws-location";
import {Queue} from "aws-cdk-lib/aws-sqs";

import * as targets from 'aws-cdk-lib/aws-events-targets';

export class CdkEventbridgeStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    //Create a new bus
    const AppEventBus = new EventBus(this, 'AppEventBus', {
      eventBusName: `AppEventBus-${Aws.STACK_NAME}`
    });
    
    // Event Sourcing / Event Store
    const EventStoreTable = new Table(this, 'EventStoreTable', {
      partitionKey: { 
        name: "who", type: AttributeType.STRING },
      sortKey: {
        name: "timeWhat", type: AttributeType.STRING
      },
    });

    const EventStoreFunction = new Function(this, "EventStoreFunction", {
      runtime: Runtime.NODEJS_14_X,
      code: Code.fromAsset("event-store"),
      handler: "app.lambdaHandler",
      environment: {
        STORE_TABLE: EventStoreTable.tableName,
      },
    });

    const StoreEventRule = new Rule(this, "StoreEventRule", {
      eventBus: AppEventBus,
      eventPattern: {   
        source: [ { prefix: ""} ] as any[] // Matches all the events in the bus
      },
    })

    StoreEventRule.addTarget(new targets.LambdaFunction(EventStoreFunction));

    EventStoreTable.grantFullAccess(EventStoreFunction);

    // Helpers layers
    const HelpersLayer = new LayerVersion(this, 'HelpersLayer', {
      layerVersionName: 'CDK-Events-Advanced-Helpers',
      description: 'Layer that will be shared across multiple microservices',
      license: 'Available under the MIT license',
      code: Code.fromAsset("helpers-layer"),
      compatibleRuntimes: [Runtime.NODEJS_14_X]  
    });
  
    const UuidLayer = new LayerVersion(this, 'UuidLayer', {
      layerVersionName: 'CDK-Events-Advanced-Uuid',
      description: 'Layer that contains one version of UUID library',
      license: 'Available under the MIT license',
      code: Code.fromAsset("uuid-layer"),
      compatibleRuntimes: [Runtime.NODEJS_14_X]  
    });

    // EventBridge Permissions
    const eventbridgePutPolicy = new PolicyStatement({
      effect: Effect.ALLOW,
      resources: ['*'],
      actions: ['events:PutEvents']
    });

    // Order Microservice
    const OrderTable = new Table(this, 'OrderTable', {
      partitionKey: { 
        name: "customerId", type: AttributeType.STRING },
      sortKey: {
        name: "orderId", type: AttributeType.STRING
      },
    });

    const OrderFunction = new Function(this, "OrderFunction", {
      runtime: Runtime.NODEJS_14_X,
      code: Code.fromAsset("order"),
      handler: "app.lambdaHandler",
      layers: [HelpersLayer, UuidLayer],
      environment: {
        ORDER_TABLE: OrderTable.tableName,
        EVENT_BUS: AppEventBus.eventBusName
      },
    });
  
    OrderTable.grantFullAccess(OrderFunction);
    OrderFunction.addToRolePolicy(eventbridgePutPolicy)

    const OrderEventRule = new Rule(this, "OrderEventRule", {
      eventBus: AppEventBus,
      eventPattern: {   
        detailType: [
          'OrderCreate',
          'PaymentMade',
          'PaymentFailed',
          'PaymentCanceled',
          'DeliveryStarted',
          'DeliveryWasDelivered',
          'DeliveryWasCanceled'
        ]
      },
    })

    OrderEventRule.addTarget(new targets.LambdaFunction(OrderFunction));

    // create the API Gateway to OrderCreate
    const OrderCreateAPI = new RestApi(this, "OrderCreateAPI");

    OrderCreateAPI.root
      .resourceForPath("/order/{action}/{customerId}/{what}")
      .addMethod("GET", new LambdaIntegration(OrderFunction));
  
    // Inventory Microservice
    const InventoryTable = new Table(this, 'InventoryTable', {
      partitionKey: { 
        name: "itemId", type: AttributeType.STRING },
    });

    const InventoryFunction = new Function(this, "InventoryFunction", {
      runtime: Runtime.NODEJS_14_X,
      code: Code.fromAsset("inventory"),
      handler: "app.lambdaHandler",
      layers: [HelpersLayer],
      environment: {
        INVENTORY_TABLE: InventoryTable.tableName,
        EVENT_BUS: AppEventBus.eventBusName
      },
    });

    InventoryTable.grantFullAccess(InventoryFunction);
    InventoryFunction.addToRolePolicy(eventbridgePutPolicy)

    const InventoryEventRule = new Rule(this, "InventoryEventRule", {
      eventBus: AppEventBus,
      eventPattern: {   
        detailType: [
          'OrderCreated',
          'OrderCanceled',
          'ItemReserved',
          'PaymentMade',
          'PaymentFailed'
        ]
      },
    })

    InventoryEventRule.addTarget(new targets.LambdaFunction(InventoryFunction));
  
     // Payment Microservice
    const PaymentTable = new Table(this, 'PaymentTable', {
      partitionKey: { 
        name: "paymentId", type: AttributeType.STRING },
    });

    const PaymentFunction = new Function(this, "PaymentFunction", {
      runtime: Runtime.NODEJS_14_X,
      code: Code.fromAsset("payment"),
      handler: "app.lambdaHandler",
      layers: [HelpersLayer, UuidLayer],
      environment: {
        PAYMENT_TABLE: PaymentTable.tableName,
        PAYMENT_FAIL_PROBABILITY: '0', // Between 0 and 1
        EVENT_BUS: AppEventBus.eventBusName
      },
    });

    PaymentTable.grantFullAccess(PaymentFunction);
    PaymentFunction.addToRolePolicy(eventbridgePutPolicy)

    const PaymentEventRule = new Rule(this, "PaymentEventRule", {
      eventBus: AppEventBus,
      eventPattern: {   
        detailType: [
          'DeliveryEstimated',
          'ItemReturned'
        ]
      },
    })

    PaymentEventRule.addTarget(new targets.LambdaFunction(PaymentFunction));

    // Customer Microservice
    const CustomerTable = new Table(this, 'CustomerTable', {
      partitionKey: { 
        name: "customerId", type: AttributeType.STRING },
    });

    const CustomerFunction = new Function(this, "CustomerFunction", {
      runtime: Runtime.NODEJS_14_X,
      code: Code.fromAsset("customer"),
      handler: "app.lambdaHandler",
      layers: [HelpersLayer],
      environment: {
        CUSTOMER_TABLE: CustomerTable.tableName,
        EVENT_BUS: AppEventBus.eventBusName
      },
    });

    CustomerTable.grantFullAccess(CustomerFunction);
    CustomerFunction.addToRolePolicy(eventbridgePutPolicy)

    const CustomerEventRule = new Rule(this, "CustomerEventRule", {
      eventBus: AppEventBus,
      eventPattern: {   
        detailType: [
          'ItemDescribed'
        ]
      },
    })

    CustomerEventRule.addTarget(new targets.LambdaFunction(CustomerFunction));
  
    //Delivery Microservice
    const MyPlaceIndex = new CfnPlaceIndex(this, 'MyPlaceIndex', {
      dataSource: 'Esri',
      indexName: `my-place-index-${Aws.STACK_NAME}`,
      pricingPlan: 'RequestBasedUsage',
    });
    
    const MyRouteCalculator = new CfnRouteCalculator(this, 'MyRouteCalculator', {
      calculatorName: `my-route-calculator-${Aws.STACK_NAME}`,
      dataSource: 'Esri',
      pricingPlan: 'RequestBasedUsage'
    });

    const DeliveryTable = new Table(this, 'DeliveryTable', {
      partitionKey: { 
        name: "customerId", type: AttributeType.STRING 
      },
      sortKey: {
        name: "orderId", type: AttributeType.STRING
      }
    });

    const DeliveryFunction = new Function(this, "DeliveryFunction", {
      runtime: Runtime.NODEJS_14_X,
      code: Code.fromAsset("delivery"),
      handler: "app.lambdaHandler",
      layers: [HelpersLayer],
      environment: {
        PLACE_INDEX: MyPlaceIndex.indexName,
        ROUTE_CALCULATOR: MyRouteCalculator.calculatorName,
        DELIVERY_TABLE: DeliveryTable.tableName,
        EVENT_BUS: AppEventBus.eventBusName
      },
    });

    DeliveryTable.grantFullAccess(DeliveryFunction);
    DeliveryFunction.addToRolePolicy(eventbridgePutPolicy)

    // Location service Permissions
    const SearchLocationServicePolicy = new PolicyStatement({
      effect: Effect.ALLOW,
      resources: [MyPlaceIndex.attrArn],
      actions: ['geo:SearchPlaceIndexForText']
    });

    const CalculateLocationServicePolicy = new PolicyStatement({
      effect: Effect.ALLOW,
      resources: [MyRouteCalculator.attrArn],
      actions: ['geo:CalculateRoute']
    });

    DeliveryFunction.addToRolePolicy(SearchLocationServicePolicy);
    DeliveryFunction.addToRolePolicy(CalculateLocationServicePolicy);

    const DeliveryEventRule = new Rule(this, "DeliveryEventRule", {
      eventBus: AppEventBus,
      eventPattern: {   
        detailType: [
          'CustomerDescribed',
          'ItemRemoved',
          'Delivered',
          'DeliveryCanceled',
        ]
      },
    })

    DeliveryEventRule.addTarget(new targets.LambdaFunction(DeliveryFunction));

    // API Destination for Delivery Service

    const DeliveryConnection = new Connection(this, 'DeliveryConnection', {
      authorization: Authorization.apiKey('ApiKeyName', SecretValue.secretsManager('api-key-cdk-stack')),
      description: 'Connection with an API key',
    });
    
    const DeliveryApiDestination = new ApiDestination(this, 'DeliveryApiDestination', {
      connection: DeliveryConnection,
      endpoint: 'https://webhook.site/926a07bb-2d15-4521-8852-bdcb7fb31906', // TODO GET FROM PARAMETERS
      httpMethod: HttpMethod.POST,
      rateLimitPerSecond: 10
    });
    
    const DeliveryApiEventRule = new Rule(this, 'DeliveryApiEventRule', {
      eventBus: AppEventBus,
      eventPattern: {   
        detailType: [
          'DeliveryMarkedAsStarted'
        ]
      },
    });

    const DeliveryServiceDLQueue = new Queue(this, 'DeliveryServiceDLQueue');

    DeliveryApiEventRule.addTarget(new targets.ApiDestination(DeliveryApiDestination, {
      deadLetterQueue: DeliveryServiceDLQueue,
      retryAttempts: 4,
      maxEventAge: Duration.seconds(60)
    }));
    
    
    //Outputs
    new CfnOutput(this, "EventStoreTableOutput", {
      value: EventStoreTable.tableName
    });
    new CfnOutput(this, "OrderTableOutput", {
      value: OrderTable.tableName
    });
    new CfnOutput(this, "InventoryTableOutput", {
      value: InventoryTable.tableName
    });
    new CfnOutput(this, "PaymentTableOutput", {
      value: PaymentTable.tableName
    });
    new CfnOutput(this, "CustomerTableOutput", {
      value: CustomerTable.tableName
    });
  }

  
  
}
